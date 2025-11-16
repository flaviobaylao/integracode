import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [apiKey, setApiKey] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Get assistant status
  const { data: assistantStatus, refetch: refetchStatus } = useQuery({
    queryKey: ["/api/settings/assistant-status"],
    enabled: isOpen,
  });

  const updateApiKeyMutation = useMutation({
    mutationFn: async (newApiKey: string) => {
      return apiRequest("POST", "/api/settings/openai-key", { apiKey: newApiKey });
    },
    onSuccess: () => {
      toast({
        title: "Sucesso",
        description: "Chave da API do ChatGPT atualizada com sucesso",
      });
      setApiKey("");
      onClose();
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao atualizar a chave da API",
        variant: "destructive",
      });
    },
  });

  const testApiKeyMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/settings/test-openai", {});
    },
    onSuccess: () => {
      toast({
        title: "Sucesso",
        description: "Conexão com ChatGPT testada com sucesso",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro na conexão",
        description: error.message || "Não foi possível conectar com o ChatGPT",
        variant: "destructive",
      });
    },
  });

  const toggleAssistantMutation = useMutation({
    mutationFn: async (isOnline: boolean) => {
      return apiRequest("POST", "/api/settings/toggle-assistant", { isOnline });
    },
    onSuccess: (data: any) => {
      toast({
        title: "Sucesso",
        description: data.message,
      });
      refetchStatus();
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao alterar status do assistente",
        variant: "destructive",
      });
    },
  });

  const handleSave = async () => {
    if (!apiKey.trim()) {
      toast({
        title: "Erro",
        description: "Por favor, insira uma chave da API válida",
        variant: "destructive",
      });
      return;
    }
    
    updateApiKeyMutation.mutate(apiKey.trim());
  };

  const handleTest = () => {
    testApiKeyMutation.mutate();
  };

  const handleToggleAssistant = () => {
    const currentStatus = assistantStatus?.isOnline || false;
    toggleAssistantMutation.mutate(!currentStatus);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-gray-900">
              Configurações do Sistema
            </h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 transition-colors"
            >
              <i className="fas fa-times text-lg"></i>
            </button>
          </div>

          <div className="space-y-4">
            <div>
              <label htmlFor="openai-key" className="block text-sm font-medium text-gray-700 mb-2">
                Chave da API ou Assistant ID do OpenAI
              </label>
              <input
                id="openai-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..., asst-... ou asst_..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-whatsapp-500 focus:border-whatsapp-500"
              />
              <p className="text-xs text-gray-500 mt-1">
                Use uma chave API (sk-...) ou um Assistant ID (asst-... ou asst_...) para o ChatGPT responder automaticamente
              </p>
            </div>

            <div className="flex space-x-3">
              <button
                onClick={handleTest}
                disabled={testApiKeyMutation.isPending}
                className="flex-1 px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors disabled:opacity-50 flex items-center justify-center space-x-2"
              >
                {testApiKeyMutation.isPending ? (
                  <i className="fas fa-spinner fa-spin"></i>
                ) : (
                  <i className="fas fa-check-circle"></i>
                )}
                <span>Testar Conexão</span>
              </button>
              
              <button
                onClick={handleSave}
                disabled={updateApiKeyMutation.isPending}
                className="flex-1 px-4 py-2 bg-whatsapp-500 text-white rounded-md hover:bg-whatsapp-600 transition-colors disabled:opacity-50 flex items-center justify-center space-x-2"
              >
                {updateApiKeyMutation.isPending ? (
                  <i className="fas fa-spinner fa-spin"></i>
                ) : (
                  <i className="fas fa-save"></i>
                )}
                <span>Salvar</span>
              </button>
            </div>

            {/* Assistant Status Control */}
            <div className="border-t pt-4 mt-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-sm font-medium text-gray-700 flex items-center space-x-2">
                    <i className="fas fa-robot text-whatsapp-500"></i>
                    <span>Assistente ChatGPT</span>
                  </h3>
                  <p className="text-xs text-gray-500">
                    Controla se o assistente está ativo para responder automaticamente
                  </p>
                </div>
                <div className="flex items-center space-x-2">
                  {assistantStatus && (
                    <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                      assistantStatus.isOnline 
                        ? 'bg-green-100 text-green-800' 
                        : 'bg-red-100 text-red-800'
                    }`}>
                      <i className={`fas ${assistantStatus.isOnline ? 'fa-wifi' : 'fa-wifi-slash'} mr-1 text-xs`}></i>
                      {assistantStatus.isOnline ? 'Online' : 'Offline'}
                    </span>
                  )}
                </div>
              </div>
              
              <button
                onClick={handleToggleAssistant}
                disabled={toggleAssistantMutation.isPending}
                className={`w-full px-4 py-2 rounded-md transition-colors disabled:opacity-50 flex items-center justify-center space-x-2 ${
                  assistantStatus?.isOnline 
                    ? 'bg-red-500 text-white hover:bg-red-600' 
                    : 'bg-green-500 text-white hover:bg-green-600'
                }`}
              >
                {toggleAssistantMutation.isPending ? (
                  <i className="fas fa-spinner fa-spin"></i>
                ) : (
                  <i className={`fas ${assistantStatus?.isOnline ? 'fa-power-off' : 'fa-power-off'}`}></i>
                )}
                <span>
                  {assistantStatus?.isOnline ? 'Desativar Assistente' : 'Ativar Assistente'}
                </span>
              </button>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-gray-200">
            <div className="flex items-center space-x-2 text-sm text-gray-600">
              <i className="fas fa-info-circle text-blue-500"></i>
              <span>
                Para obter uma chave da API, visite{" "}
                <a
                  href="https://platform.openai.com/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline"
                >
                  platform.openai.com
                </a>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}