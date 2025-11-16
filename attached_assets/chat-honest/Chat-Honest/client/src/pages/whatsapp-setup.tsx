import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
// import logoImage from "@assets/folha icone_1755477689163.JPG";

interface WhatsAppSetupProps {
  user: {
    id: string;
    username: string;
    email: string;
    role: 'admin' | 'agent' | 'delivery';
  };
  onLogout: () => void;
  onNavigateBack: () => void;
}

export function WhatsAppSetupPage({ user, onLogout, onNavigateBack }: WhatsAppSetupProps) {
  const [qrCode, setQrCode] = useState<string>("");
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'qr_ready'>('disconnected');
  const [phoneNumber, setPhoneNumber] = useState<string>("");
  const { toast } = useToast();

  // Fetch current WhatsApp connection status
  const { data: connectionData, refetch: refetchConnection } = useQuery({
    queryKey: ["/api/whatsapp/status"],
    refetchInterval: connectionStatus === 'connecting' || connectionStatus === 'qr_ready' ? 2000 : 30000,
  });

  // Generate QR Code mutation
  const generateQRMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/whatsapp/generate-qr", {});
      return await response.json();
    },
    onSuccess: (data) => {
      if (data.qrCode) {
        setQrCode(data.qrCode);
        setConnectionStatus('qr_ready');
        toast({
          title: "QR Code gerado",
          description: "Escaneie o código QR com seu WhatsApp para conectar",
        });
      }
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: "Não foi possível gerar o QR Code: " + error.message,
        variant: "destructive",
      });
    },
  });

  // Disconnect WhatsApp mutation
  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/whatsapp/disconnect", {});
      return await response.json();
    },
    onSuccess: () => {
      setConnectionStatus('disconnected');
      setQrCode("");
      setPhoneNumber("");
      toast({
        title: "Desconectado",
        description: "WhatsApp Business foi desconectado com sucesso",
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
      setPhoneNumber(data.phoneNumber || "");
      
      if (data.status === 'connected') {
        setQrCode("");
        toast({
          title: "Conectado",
          description: `WhatsApp Business conectado: ${data.phoneNumber}`,
        });
      }
    }
  }, [connectionData, toast]);

  const handleGenerateQR = () => {
    generateQRMutation.mutate();
  };

  const handleDisconnect = () => {
    if (window.confirm('Tem certeza que deseja desconectar o WhatsApp Business?')) {
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
              <div className="h-10 w-10 flex items-center justify-center bg-whatsapp-500 rounded-full">
                <i className="fab fa-whatsapp text-white text-xl"></i>
              </div>
              <div>
                <h1 className="text-xl font-semibold text-gray-900">Configuração WhatsApp Business</h1>
                <p className="text-sm text-gray-600">Conecte seu número de telefone</p>
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
        {/* WhatsApp Connection Notice */}
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <i className="fas fa-info-circle text-amber-500 text-xl"></i>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-amber-800">
                Demonstração do Sistema WhatsApp Business
              </h3>
              <div className="mt-2 text-sm text-amber-700">
                <p>Este é um sistema de demonstração que simula a conexão com WhatsApp Business. Para usar com seu WhatsApp real, seria necessário:</p>
                <ul className="mt-2 list-disc list-inside space-y-1">
                  <li>API oficial do WhatsApp Business</li>
                  <li>Configuração de webhook autorizado</li>
                  <li>Verificação do número de telefone business</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Connection Status Card */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center mb-6">
              <div className="h-12 w-12 bg-whatsapp-500 rounded-full flex items-center justify-center mr-4">
                <i className="fab fa-whatsapp text-white text-xl"></i>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Status da Conexão</h2>
                <p className="text-sm text-gray-600">Situação atual do WhatsApp Business</p>
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
                       connectionStatus === 'qr_ready' ? 'Aguardando escaneamento' : 'Desconectado'}
                    </p>
                    {phoneNumber && (
                      <p className="text-sm text-gray-600">{phoneNumber}</p>
                    )}
                  </div>
                </div>
                <div>
                  {connectionStatus === 'connected' ? (
                    <button
                      onClick={handleDisconnect}
                      disabled={disconnectMutation.isPending}
                      className="inline-flex items-center px-3 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50"
                    >
                      {disconnectMutation.isPending ? (
                        <>
                          <i className="fas fa-spinner fa-spin mr-2"></i>
                          Desconectando...
                        </>
                      ) : (
                        <>
                          <i className="fas fa-unlink mr-2"></i>
                          Desconectar
                        </>
                      )}
                    </button>
                  ) : (
                    <button
                      onClick={handleGenerateQR}
                      disabled={generateQRMutation.isPending || connectionStatus === 'connecting' || connectionStatus === 'qr_ready'}
                      className="inline-flex items-center px-3 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-whatsapp-600 hover:bg-whatsapp-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-whatsapp-500 disabled:opacity-50"
                    >
                      {generateQRMutation.isPending ? (
                        <>
                          <i className="fas fa-spinner fa-spin mr-2"></i>
                          Gerando...
                        </>
                      ) : (
                        <>
                          <i className="fas fa-qrcode mr-2"></i>
                          Gerar QR Code
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* QR Code Card */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="text-center">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">QR Code de Conexão</h2>
              
              {qrCode ? (
                <div className="space-y-4">
                  <div className="bg-white p-4 rounded-lg border-2 border-gray-200 inline-block">
                    <img 
                      src={`data:image/png;base64,${qrCode}`} 
                      alt="QR Code do WhatsApp" 
                      className="w-64 h-64 object-contain"
                    />
                  </div>
                  <div className="text-sm text-gray-600 space-y-2">
                    <p className="font-medium">Como conectar:</p>
                    <ol className="text-left space-y-1">
                      <li>1. Abra o WhatsApp Business no seu celular</li>
                      <li>2. Toque no menu (⋮) e selecione "Dispositivos conectados"</li>
                      <li>3. Toque em "Conectar um dispositivo"</li>
                      <li>4. Aponte a câmera para este QR code</li>
                    </ol>
                  </div>
                  {connectionStatus === 'connecting' && (
                    <div className="flex items-center justify-center text-yellow-600">
                      <i className="fas fa-spinner fa-spin mr-2"></i>
                      Aguardando conexão...
                    </div>
                  )}
                </div>
              ) : (
                <div className="py-16">
                  <div className="w-32 h-32 bg-gray-100 rounded-lg flex items-center justify-center mx-auto mb-4">
                    <i className="fas fa-qrcode text-gray-400 text-4xl"></i>
                  </div>
                  <p className="text-gray-500">
                    {connectionStatus === 'connected' 
                      ? 'WhatsApp já está conectado' 
                      : 'Clique em "Gerar QR Code" para começar'
                    }
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Instructions Card */}
        <div className="mt-8 bg-blue-50 border border-blue-200 rounded-lg p-6">
          <div className="flex items-start">
            <div className="h-6 w-6 bg-blue-500 rounded-full flex items-center justify-center flex-shrink-0 mt-1">
              <i className="fas fa-info text-white text-sm"></i>
            </div>
            <div className="ml-4">
              <h3 className="text-lg font-medium text-blue-900 mb-2">Informações Importantes</h3>
              <div className="text-sm text-blue-800 space-y-2">
                <p>• O WhatsApp Business deve estar instalado e configurado no seu dispositivo móvel</p>
                <p>• Certifique-se de que seu telefone está conectado à internet</p>
                <p>• Apenas números de WhatsApp Business podem ser conectados ao sistema</p>
                <p>• A conexão permanece ativa mesmo se você fechar o navegador</p>
                <p>• Para desconectar, use o botão "Desconectar" ou remova a sessão no WhatsApp</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}