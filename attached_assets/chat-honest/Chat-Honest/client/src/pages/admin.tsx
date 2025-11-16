import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useWebSocket } from "@/hooks/use-websocket";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, LineChart, Line, PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import logoImage from "@/assets/logo.jpg";

interface AdminPageProps {
  user: any;
  onLogout: () => void;
  onNavigateToDashboard: () => void;
  onNavigateToWhatsAppSetup?: () => void;
  onNavigateToWhatsAppAnalysis?: () => void;
}

export function AdminPage({ user, onLogout, onNavigateToDashboard, onNavigateToWhatsAppSetup, onNavigateToWhatsAppAnalysis }: AdminPageProps) {
  const [location] = useLocation();
  const [activeTab, setActiveTab] = useState("dashboard");
  
  // Connect to WebSocket for real-time updates
  useWebSocket();

  // Auto-select settings tab when on /settings route
  useEffect(() => {
    if (location === "/settings") {
      setActiveTab("settings");
    }
  }, [location]);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [showCreateQuickMessage, setShowCreateQuickMessage] = useState(false);
  const [editingMessage, setEditingMessage] = useState<any>(null);
  const [newAgent, setNewAgent] = useState({
    username: "",
    email: "",
    name: "",
    passwordHash: "",
    role: "agent" as "agent" | "admin",
  });
  const [newQuickMessage, setNewQuickMessage] = useState({
    title: "",
    content: "",
    messageType: "text",
    isActive: true,
  });
  const [reportRange, setReportRange] = useState({
    startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // Last 30 days
    endDate: new Date().toISOString().split('T')[0],
  });
  const [exportRange, setExportRange] = useState({
    startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    endDate: new Date().toISOString().split('T')[0],
  });
  const [topCustomersFilter, setTopCustomersFilter] = useState({
    days: 30,
    metric: 'conversations' // 'conversations' or 'time'
  });
  const [whatsappConfig, setWhatsappConfig] = useState({
    accessToken: '',
    phoneNumberId: '',
    webhookVerifyToken: '',
    businessAccountId: ''
  });
  const [showWhatsappTokens, setShowWhatsappTokens] = useState(false);
  
  // Evolution API states
  const [evolutionConfig, setEvolutionConfig] = useState({
    apiUrl: '',
    apiKey: '',
    instanceName: ''
  });
  const [showEvolutionConfig, setShowEvolutionConfig] = useState(false);
  const [showEvolutionQR, setShowEvolutionQR] = useState(false);
  const [evolutionQRCode, setEvolutionQRCode] = useState<string | null>(null);

  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Export conversations function
  const exportConversations = async () => {
    try {
      const response = await fetch(`/api/admin/export/conversations?startDate=${exportRange.startDate}&endDate=${exportRange.endDate}`, {
        method: 'GET',
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Erro ao exportar conversas');
      }

      // Get the blob and create a download
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `conversas_${exportRange.startDate}_${exportRange.endDate}.xlsx`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      toast({
        title: "Sucesso",
        description: "Relatório de conversas exportado com sucesso",
      });
    } catch (error: any) {
      toast({
        title: "Erro",
        description: error.message || "Erro ao exportar conversas",
        variant: "destructive",
      });
    }
  };

  // Fetch ChatGPT priority setting
  const { data: chatGPTPrioritySetting } = useQuery({
    queryKey: ["/api/admin/settings", "chatgpt_priority_mode"],
    queryFn: async () => {
      try {
        const response = await apiRequest("GET", "/api/admin/settings/chatgpt_priority_mode");
        const data = await response.json();
        console.log('📊 ChatGPT priority setting fetched:', data);
        return data;
      } catch (error) {
        console.log('⚠️ ChatGPT priority setting not found, using default');
        // Setting doesn't exist yet, return default
        return { key: "chatgpt_priority_mode", value: "false" };
      }
    },
    staleTime: 0, // Force fresh data every time
    gcTime: 0, // Don't cache the result
    refetchOnMount: true // Always refetch on mount
  });

  const chatGPTPriorityEnabled = chatGPTPrioritySetting?.value === 'true';
  console.log('🎛️ Current chatGPTPriorityEnabled state:', chatGPTPriorityEnabled, 'from value:', chatGPTPrioritySetting?.value);

  // Toggle ChatGPT priority mutation
  const toggleChatGPTPriorityMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      console.log('🔧 Toggling ChatGPT priority to:', enabled);
      const response = await apiRequest("POST", "/api/admin/chatgpt-priority", { enabled });
      console.log('✅ API Response:', response);
      return response;
    },
    onSuccess: async (response) => {
      const data = await response.json();
      console.log('🎉 onSuccess called with data:', data);
      console.log('🔄 Current state before invalidation:', chatGPTPriorityEnabled);
      toast({
        title: "Sucesso",
        description: `Modo de prioridade do ChatGPT ${data.enabled ? 'habilitado' : 'desabilitado'} com sucesso`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/settings", "chatgpt_priority_mode"] });
    },
    onError: (error: any) => {
      console.error('❌ Mutation error:', error);
      toast({
        title: "Erro",
        description: error.message || "Erro ao alterar configuração",
        variant: "destructive",
      });
    },
  });

  // Fetch users
  const { data: users = [] } = useQuery({
    queryKey: ["/api/admin/users"],
  });

  // Fetch reports
  const { data: reports = [] } = useQuery({
    queryKey: ["/api/admin/reports"],
  });

  // Fetch audit logs
  const { data: auditLogs = [] } = useQuery({
    queryKey: ["/api/admin/audit"],
  });

  // Fetch quick messages
  const { data: quickMessages = [] } = useQuery({
    queryKey: ["/api/quick-messages"],
  });

  // Fetch agents with real-time updates
  const { data: agents = [] } = useQuery({
    queryKey: ["/api/agents"],
    refetchInterval: 5000, // Refresh every 5 seconds for real-time status
  });

  // Fetch top customers statistics
  const { data: topCustomers = { customers: [] } } = useQuery({
    queryKey: ["/api/admin/stats/top-customers", topCustomersFilter.days, topCustomersFilter.metric],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/admin/stats/top-customers?days=${topCustomersFilter.days}&metric=${topCustomersFilter.metric}`);
      return response.json();
    },
  });

  // Fetch WhatsApp Official API status
  const { data: whatsappStatus } = useQuery({
    queryKey: ["/api/admin/whatsapp-official/status"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/admin/whatsapp-official/status");
      return response.json();
    },
  });

  // Fetch Evolution API status
  const { data: evolutionStatus, refetch: refetchEvolutionStatus, isLoading: evolutionStatusLoading } = useQuery({
    queryKey: ["/api/admin/evolution/status"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/admin/evolution/status");
      return response.json();
    },
    enabled: true, // Ensure query runs
  });

  // Fetch Hybrid WhatsApp Status (Evolution + Official + Simulation)
  const { data: hybridStatus } = useQuery({
    queryKey: ["/api/whatsapp/hybrid-status"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/whatsapp/hybrid-status");
      return response.json();
    },
    refetchInterval: 10000, // Refresh every 10 seconds
  });

  // Create agent mutation
  const createAgentMutation = useMutation({
    mutationFn: async (agentData: any) => {
      return apiRequest("POST", "/api/admin/agents", agentData);
    },
    onSuccess: () => {
      toast({
        title: "Sucesso",
        description: "Agente criado com sucesso",
      });
      setShowCreateAgent(false);
      setNewAgent({ username: "", email: "", name: "", passwordHash: "", role: "agent" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao criar agente",
        variant: "destructive",
      });
    },
  });

  // Generate report mutation
  const generateReportMutation = useMutation({
    mutationFn: async (reportData: any) => {
      return apiRequest("POST", "/api/admin/reports", reportData);
    },
    onSuccess: () => {
      toast({
        title: "Sucesso",
        description: "Relatório gerado com sucesso",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/reports"] });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao gerar relatório",
        variant: "destructive",
      });
    },
  });

  // Delete user mutation
  const deleteUserMutation = useMutation({
    mutationFn: async (userId: string) => {
      return apiRequest("DELETE", `/api/admin/agents/${userId}`, {});
    },
    onSuccess: () => {
      toast({
        title: "Sucesso",
        description: "Usuário excluído com sucesso",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao excluir usuário",
        variant: "destructive",
      });
    },
  });

  // Create quick message mutation
  const createQuickMessageMutation = useMutation({
    mutationFn: async (messageData: any) => {
      return apiRequest("POST", "/api/quick-messages", messageData);
    },
    onSuccess: () => {
      toast({
        title: "Sucesso",
        description: "Mensagem rápida criada com sucesso",
      });
      setShowCreateQuickMessage(false);
      setNewQuickMessage({ title: "", content: "", messageType: "text", isActive: true });
      queryClient.invalidateQueries({ queryKey: ["/api/quick-messages"] });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao criar mensagem rápida",
        variant: "destructive",
      });
    },
  });

  // Update quick message mutation
  const updateQuickMessageMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      return apiRequest("PUT", `/api/quick-messages/${id}`, data);
    },
    onSuccess: () => {
      toast({
        title: "Sucesso",
        description: "Mensagem rápida atualizada com sucesso",
      });
      setEditingMessage(null);
      queryClient.invalidateQueries({ queryKey: ["/api/quick-messages"] });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao atualizar mensagem rápida",
        variant: "destructive",
      });
    },
  });

  // Delete quick message mutation
  const deleteQuickMessageMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/quick-messages/${id}`, {});
    },
    onSuccess: () => {
      toast({
        title: "Sucesso",
        description: "Mensagem rápida excluída com sucesso",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/quick-messages"] });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao excluir mensagem rápida",
        variant: "destructive",
      });
    },
  });

  // Logout mutation
  const logoutMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/auth/logout", {});
    },
    onSuccess: () => {
      onLogout();
    },
  });

  // Configure WhatsApp Official API mutation
  const configureWhatsAppMutation = useMutation({
    mutationFn: async (config: typeof whatsappConfig) => {
      const response = await apiRequest("POST", "/api/admin/whatsapp-official/configure", config);
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Sucesso",
        description: "API oficial do WhatsApp configurada com sucesso",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/whatsapp-official/status"] });
      setWhatsappConfig({ accessToken: '', phoneNumberId: '', webhookVerifyToken: '', businessAccountId: '' });
      setShowWhatsappTokens(false);
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao configurar API oficial do WhatsApp",
        variant: "destructive",
      });
    },
  });

  // Test WhatsApp Official API connection mutation
  const testWhatsAppMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/admin/whatsapp-official/test");
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Sucesso",
        description: `Conexão testada com sucesso! Número: ${data.phoneNumber}`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao testar conexão com API oficial",
        variant: "destructive",
      });
    },
  });

  // Configure Evolution API mutation
  const configureEvolutionMutation = useMutation({
    mutationFn: async (config: typeof evolutionConfig) => {
      const response = await apiRequest("POST", "/api/admin/evolution/configure", config);
      return response.json();
    },
    onSuccess: async () => {
      toast({
        title: "Sucesso",
        description: "Evolution API configurada com sucesso",
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/evolution/status"] });
      await refetchEvolutionStatus();
      setEvolutionConfig({ apiUrl: '', apiKey: '', instanceName: '' });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao configurar Evolution API",
        variant: "destructive",
      });
    },
  });

  // Test Evolution API connection mutation
  const testEvolutionMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/admin/evolution/test");
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Sucesso",
        description: `Conexão testada com sucesso! ${data.instances?.length || 0} instâncias encontradas`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao testar conexão Evolution API",
        variant: "destructive",
      });
    },
  });

  // Connect Evolution API instance mutation
  const connectEvolutionMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/admin/evolution/connect");
      return response.json();
    },
    onSuccess: (data) => {
      // Check if already connected
      if (data.alreadyConnected) {
        toast({
          title: "Já Conectado",
          description: data.message || "WhatsApp já está conectado!",
        });
        queryClient.invalidateQueries({ queryKey: ["/api/admin/evolution/status"] });
        refetchEvolutionStatus();
        return;
      }

      // Show QR code if available
      if (data.qrcode) {
        setEvolutionQRCode(data.qrcode.base64 || data.qrcode);
        setShowEvolutionQR(true);
        
        toast({
          title: "QR Code Gerado",
          description: data.message || "Escaneie o QR Code com WhatsApp",
        });

        // Poll for connection status
        const pollInterval = setInterval(async () => {
          const statusResponse = await apiRequest("GET", "/api/admin/evolution/status");
          const status = await statusResponse.json();
          
          if (status.connected) {
            clearInterval(pollInterval);
            setShowEvolutionQR(false);
            setEvolutionQRCode(null);
            refetchEvolutionStatus();
            toast({
              title: "Conectado!",
              description: "WhatsApp conectado via Evolution API",
            });
          }
        }, 3000);

        // Stop polling after 2 minutes
        setTimeout(() => clearInterval(pollInterval), 120000);
      } else {
        toast({
          title: "Aviso",
          description: data.message || "Operação concluída",
        });
      }
      
      queryClient.invalidateQueries({ queryKey: ["/api/admin/evolution/status"] });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao conectar Evolution API",
        variant: "destructive",
      });
    },
  });

  // Disconnect Evolution API instance mutation
  const disconnectEvolutionMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/admin/evolution/disconnect");
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Sucesso",
        description: "WhatsApp desconectado com sucesso",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/evolution/status"] });
      setShowEvolutionQR(false);
      setEvolutionQRCode(null);
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao desconectar",
        variant: "destructive",
      });
    },
  });

  // Reconfigure Evolution API Webhook mutation
  const reconfigureWebhookMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("POST", "/api/evolution/reconfigure-webhook", {});
    },
    onSuccess: (data) => {
      toast({
        title: "Webhook Reconfigurado!",
        description: `Eventos: ${data.events?.join(', ') || 'Configurado com sucesso'}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/evolution/status"] });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao Reconfigurar",
        description: error.message || "Não foi possível reconfigurar o webhook",
        variant: "destructive",
      });
    },
  });

  // Check Evolution webhook status
  const { data: webhookStatus, refetch: refetchWebhookStatus } = useQuery({
    queryKey: ["/api/admin/evolution/webhook-status"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/admin/evolution/webhook-status");
      return response.json();
    },
    enabled: evolutionStatus?.isConfigured === true,
  });

  // Fix Evolution webhook mutation
  const fixWebhookMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/admin/evolution/fix-webhook");
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Webhook Corrigido!",
        description: "Webhook reconfigurado para URL de produção com sucesso",
      });
      refetchWebhookStatus();
      queryClient.invalidateQueries({ queryKey: ["/api/admin/evolution/status"] });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao Corrigir Webhook",
        description: error.message || "Não foi possível corrigir o webhook",
        variant: "destructive",
      });
    },
  });

  // Restart Evolution connection mutation
  const restartConnectionMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/admin/evolution/restart-connection");
      return response.json();
    },
    onSuccess: (data) => {
      if (data.qrcode) {
        setEvolutionQRCode(data.qrcode);
        setShowEvolutionQR(true);
        toast({
          title: "Conexão Reiniciada!",
          description: "Escaneie o novo QR Code para reconectar",
        });

        // Poll for connection status
        const pollInterval = setInterval(async () => {
          const statusResult = await evolutionAPIService.getInstanceStatus('BOTHONEST');
          if (statusResult.status === 'open') {
            clearInterval(pollInterval);
            setShowEvolutionQR(false);
            setEvolutionQRCode(null);
            refetchEvolutionStatus();
            toast({
              title: "Reconectado!",
              description: "WhatsApp reconectado com sucesso - webhooks reativados",
            });
          }
        }, 3000);

        // Stop polling after 2 minutes
        setTimeout(() => clearInterval(pollInterval), 120000);
      }
      refetchWebhookStatus();
      queryClient.invalidateQueries({ queryKey: ["/api/admin/evolution/status"] });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao Reiniciar",
        description: error.message || "Não foi possível reiniciar a conexão",
        variant: "destructive",
      });
    },
  });

  const handleCreateQuickMessage = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!newQuickMessage.title || !newQuickMessage.content) {
      toast({
        title: "Erro",
        description: "Título e conteúdo são obrigatórios",
        variant: "destructive",
      });
      return;
    }
    
    createQuickMessageMutation.mutate(newQuickMessage);
  };

  const handleUpdateQuickMessage = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!editingMessage.title || !editingMessage.content) {
      toast({
        title: "Erro",
        description: "Título e conteúdo são obrigatórios",
        variant: "destructive",
      });
      return;
    }
    
    updateQuickMessageMutation.mutate({
      id: editingMessage.id,
      data: {
        title: editingMessage.title,
        content: editingMessage.content,
        messageType: editingMessage.messageType,
        isActive: editingMessage.isActive,
      }
    });
  };

  const handleDeleteQuickMessage = (id: string, title: string) => {
    if (window.confirm(`Tem certeza que deseja excluir a mensagem "${title}"?`)) {
      deleteQuickMessageMutation.mutate(id);
    }
  };

  const handleEditQuickMessage = (message: any) => {
    setEditingMessage({ ...message });
  };

  const handleCreateAgent = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!newAgent.username || !newAgent.email || !newAgent.name || !newAgent.passwordHash) {
      toast({
        title: "Erro",
        description: "Por favor, preencha todos os campos",
        variant: "destructive",
      });
      return;
    }

    createAgentMutation.mutate(newAgent);
  };

  const handleGenerateReport = () => {
    generateReportMutation.mutate({
      type: "custom",
      startDate: reportRange.startDate,
      endDate: reportRange.endDate,
    });
  };

  const handleDeleteUser = (userId: string, username: string) => {
    if (window.confirm(`Tem certeza que deseja excluir o usuário "${username}"? Esta ação não pode ser desfeita.`)) {
      deleteUserMutation.mutate(userId);
    }
  };

  // Fetch real dashboard statistics
  const { data: dashboardStats, isLoading: statsLoading } = useQuery({
    queryKey: ["/api/admin/stats/dashboard?days=30"],
    refetchInterval: 60000, // Refresh every minute
  });

  // Use real data from API or fallback to empty state
  const reportData = dashboardStats || {
    totalConversations: 0,
    resolvedConversations: 0,
    agentPerformance: [],
  };

  const conversationStatusData = [
    { name: "Resolvidas", value: reportData.resolvedConversations, color: "#10B981" },
    { name: "Pendentes", value: reportData.totalConversations - reportData.resolvedConversations, color: "#F59E0B" },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div className="flex items-center space-x-4">
              <div className="h-10 w-10 flex items-center justify-center">
                <img 
                  src={logoImage} 
                  alt="Sistema Logo" 
                  className="h-10 w-10 rounded-full object-cover shadow-md"
                />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-gray-900">Painel Administrativo</h1>
                <p className="text-sm text-gray-600">Bem-vindo, {user.username}</p>
              </div>
            </div>
            <div className="flex items-center space-x-3">
              <button
                onClick={onNavigateToDashboard}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-whatsapp-600 hover:bg-whatsapp-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-whatsapp-500"
              >
                <i className="fas fa-comments mr-2"></i>
                Ir para Atendimento
              </button>
              {onNavigateToWhatsAppSetup && (
                <button
                  onClick={onNavigateToWhatsAppSetup}
                  className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
                >
                  <i className="fab fa-whatsapp mr-2"></i>
                  Configurar WhatsApp
                </button>
              )}
              {onNavigateToWhatsAppAnalysis && (
                <button
                  onClick={onNavigateToWhatsAppAnalysis}
                  className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-purple-600 hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500"
                  data-testid="button-whatsapp-analysis"
                >
                  <i className="fas fa-chart-line mr-2"></i>
                  Análise WhatsApp
                </button>
              )}
              <button
                onClick={() => logoutMutation.mutate()}
                disabled={logoutMutation.isPending}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50"
              >
                <i className="fas fa-sign-out-alt mr-2"></i>
                Sair
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Navigation Tabs */}
        <div className="mb-8">
          <div className="border-b border-gray-200">
            <nav className="-mb-px flex space-x-8">
              <button
                onClick={() => setActiveTab("dashboard")}
                className={`py-2 px-1 border-b-2 font-medium text-sm ${
                  activeTab === "dashboard"
                    ? "border-whatsapp-500 text-whatsapp-600"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                }`}
              >
                <i className="fas fa-chart-bar mr-2"></i>
                Dashboard
              </button>
              <button
                onClick={() => setActiveTab("quick-messages")}
                className={`py-2 px-1 border-b-2 font-medium text-sm ${
                  activeTab === "quick-messages"
                    ? "border-whatsapp-500 text-whatsapp-600"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                }`}
              >
                <i className="fas fa-comment-dots mr-2"></i>
                Mensagens Rápidas
              </button>
              <button
                onClick={() => setActiveTab("users")}
                className={`py-2 px-1 border-b-2 font-medium text-sm ${
                  activeTab === "users"
                    ? "border-whatsapp-500 text-whatsapp-600"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                }`}
              >
                <i className="fas fa-users mr-2"></i>
                Usuários
              </button>
              <button
                onClick={() => setActiveTab("agents-status")}
                className={`py-2 px-1 border-b-2 font-medium text-sm ${
                  activeTab === "agents-status"
                    ? "border-whatsapp-500 text-whatsapp-600"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                }`}
              >
                <i className="fas fa-user-circle mr-2"></i>
                Status dos Agentes
              </button>
              <button
                onClick={() => setActiveTab("reports")}
                className={`py-2 px-1 border-b-2 font-medium text-sm ${
                  activeTab === "reports"
                    ? "border-whatsapp-500 text-whatsapp-600"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                }`}
              >
                <i className="fas fa-chart-line mr-2"></i>
                Relatórios
              </button>
              <button
                onClick={() => setActiveTab("audit")}
                className={`py-2 px-1 border-b-2 font-medium text-sm ${
                  activeTab === "audit"
                    ? "border-whatsapp-500 text-whatsapp-600"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                }`}
                data-testid="tab-audit"
              >
                <i className="fas fa-clipboard-list mr-2"></i>
                Auditoria
              </button>
              <button
                onClick={() => setActiveTab("export")}
                className={`py-2 px-1 border-b-2 font-medium text-sm ${
                  activeTab === "export"
                    ? "border-whatsapp-500 text-whatsapp-600"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                }`}
                data-testid="tab-export"
              >
                <i className="fas fa-download mr-2"></i>
                Exportação
              </button>
              <button
                onClick={() => setActiveTab("settings")}
                className={`py-2 px-1 border-b-2 font-medium text-sm ${
                  activeTab === "settings"
                    ? "border-whatsapp-500 text-whatsapp-600"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                }`}
                data-testid="tab-settings"
              >
                <i className="fas fa-cog mr-2"></i>
                Configurações
              </button>
            </nav>
          </div>
        </div>
        {/* Tab Content */}
        {activeTab === "dashboard" && (
          <>
            {/* Stats Overview */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <i className="fas fa-users text-blue-500 text-2xl"></i>
              </div>
              <div className="ml-4">
                <p className="text-sm text-gray-600">Total de Usuários</p>
                <p className="text-2xl font-semibold text-gray-900">{users.length}</p>
              </div>
            </div>
          </div>
          
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <i className="fas fa-comments text-green-500 text-2xl"></i>
              </div>
              <div className="ml-4">
                <p className="text-sm text-gray-600">Conversas Totais</p>
                <p className="text-2xl font-semibold text-gray-900">{reportData.totalConversations}</p>
              </div>
            </div>
          </div>
          
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <i className="fas fa-check-circle text-green-500 text-2xl"></i>
              </div>
              <div className="ml-4">
                <p className="text-sm text-gray-600">Conversas Resolvidas</p>
                <p className="text-2xl font-semibold text-gray-900">{reportData.resolvedConversations}</p>
              </div>
            </div>
          </div>
          
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <i className="fas fa-chart-line text-purple-500 text-2xl"></i>
              </div>
              <div className="ml-4">
                <p className="text-sm text-gray-600">Taxa de Resolução</p>
                <p className="text-2xl font-semibold text-gray-900">
                  {reportData.totalConversations > 0 ? Math.round((reportData.resolvedConversations / reportData.totalConversations) * 100) : 0}%
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
          {/* Agent Performance Chart */}
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Performance dos Agentes</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={reportData.agentPerformance}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="agentName" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="conversationsHandled" fill="#10B981" name="Conversas Atendidas" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Conversation Status Chart */}
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Status das Conversas</h3>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={conversationStatusData}
                  cx="50%"
                  cy="50%"
                  outerRadius={100}
                  fill="#8884d8"
                  dataKey="value"
                  label={({ name, value }) => `${name}: ${value}`}
                >
                  {conversationStatusData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* User Management */}
          <div className="bg-white rounded-lg shadow">
            <div className="p-6 border-b border-gray-200">
              <div className="flex justify-between items-center">
                <h3 className="text-lg font-semibold text-gray-900">Gerenciar Usuários</h3>
                <button
                  onClick={() => setShowCreateAgent(true)}
                  className="inline-flex items-center px-3 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-whatsapp-600 hover:bg-whatsapp-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-whatsapp-500"
                >
                  <i className="fas fa-plus mr-2"></i>
                  Novo Agente
                </button>
              </div>
            </div>
            <div className="p-6">
              <div className="space-y-4">
                {users.map((user: any) => (
                  <div key={user.id} className="flex items-center justify-between p-4 border border-gray-200 rounded-lg">
                    <div className="flex-1">
                      <p className="font-medium text-gray-900">{user.username}</p>
                      <p className="text-sm text-gray-600">{user.email}</p>
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        user.role === 'admin' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'
                      }`}>
                        {user.role === 'admin' ? 'Administrador' : 'Agente'}
                      </span>
                    </div>
                    <div className="flex items-center space-x-4">
                      <div className="text-sm text-gray-500">
                        {user.lastLogin ? new Date(user.lastLogin).toLocaleDateString() : 'Nunca logou'}
                      </div>
                      {user.role !== 'admin' && (
                        <button
                          onClick={() => handleDeleteUser(user.id, user.username)}
                          disabled={deleteUserMutation.isPending}
                          className="inline-flex items-center px-3 py-1 border border-transparent text-sm font-medium rounded-md text-red-700 bg-red-100 hover:bg-red-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50"
                        >
                          <i className="fas fa-trash mr-1"></i>
                          Excluir
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Reports Generation */}
          <div className="bg-white rounded-lg shadow">
            <div className="p-6 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Gerar Relatórios</h3>
            </div>
            <div className="p-6">
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Data Início
                    </label>
                    <input
                      type="date"
                      value={reportRange.startDate}
                      onChange={(e) => setReportRange(prev => ({ ...prev, startDate: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-whatsapp-500 focus:border-whatsapp-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Data Fim
                    </label>
                    <input
                      type="date"
                      value={reportRange.endDate}
                      onChange={(e) => setReportRange(prev => ({ ...prev, endDate: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-whatsapp-500 focus:border-whatsapp-500"
                    />
                  </div>
                </div>
                
                <button
                  onClick={handleGenerateReport}
                  disabled={generateReportMutation.isPending}
                  className="w-full inline-flex justify-center items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
                >
                  {generateReportMutation.isPending ? (
                    <>
                      <i className="fas fa-spinner fa-spin mr-2"></i>
                      Gerando...
                    </>
                  ) : (
                    <>
                      <i className="fas fa-chart-bar mr-2"></i>
                      Gerar Relatório
                    </>
                  )}
                </button>

                <div className="mt-6">
                  <h4 className="text-sm font-medium text-gray-900 mb-3">Relatórios Recentes</h4>
                  <div className="space-y-2">
                    {reports.slice(0, 5).map((report: any) => (
                      <div key={report.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                        <div>
                          <p className="text-sm font-medium text-gray-900">
                            Relatório {report.type}
                          </p>
                          <p className="text-xs text-gray-500">
                            {new Date(report.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                        <button className="text-blue-600 hover:text-blue-800 text-sm">
                          <i className="fas fa-download"></i>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
          </>
        )}

        {/* Quick Messages Tab */}
        {activeTab === "quick-messages" && (
          <div className="space-y-6">
            <div className="bg-white rounded-lg shadow">
              <div className="p-6 border-b border-gray-200">
                <div className="flex justify-between items-center">
                  <h3 className="text-lg font-semibold text-gray-900">Mensagens Rápidas</h3>
                  <button
                    onClick={() => setShowCreateQuickMessage(true)}
                    className="inline-flex items-center px-3 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-whatsapp-600 hover:bg-whatsapp-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-whatsapp-500"
                  >
                    <i className="fas fa-plus mr-2"></i>
                    Nova Mensagem
                  </button>
                </div>
              </div>
              <div className="p-6">
                <div className="grid grid-cols-1 gap-4">
                  {quickMessages.map((message: any) => (
                    <div key={message.id} className="border border-gray-200 rounded-lg p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center space-x-2 mb-2">
                            <h4 className="text-lg font-medium text-gray-900">{message.title}</h4>
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                              message.isActive 
                                ? 'bg-green-100 text-green-800' 
                                : 'bg-gray-100 text-gray-800'
                            }`}>
                              {message.isActive ? 'Ativa' : 'Inativa'}
                            </span>
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                              {message.messageType === 'product_menu' ? 'Cardápio' : message.messageType === 'order_form' ? 'Pedido' : 'Texto'}
                            </span>
                          </div>
                          <p className="text-sm text-gray-600 mb-3 whitespace-pre-wrap">
                            {message.content.length > 200 
                              ? `${message.content.substring(0, 200)}...` 
                              : message.content}
                          </p>
                          <p className="text-xs text-gray-400">
                            Criada em {new Date(message.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="flex items-center space-x-2 ml-4">
                          <button
                            onClick={() => handleEditQuickMessage(message)}
                            className="inline-flex items-center px-3 py-1 border border-transparent text-sm font-medium rounded-md text-blue-700 bg-blue-100 hover:bg-blue-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                          >
                            <i className="fas fa-edit mr-1"></i>
                            Editar
                          </button>
                          <button
                            onClick={() => handleDeleteQuickMessage(message.id, message.title)}
                            disabled={deleteQuickMessageMutation.isPending}
                            className="inline-flex items-center px-3 py-1 border border-transparent text-sm font-medium rounded-md text-red-700 bg-red-100 hover:bg-red-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50"
                          >
                            <i className="fas fa-trash mr-1"></i>
                            Excluir
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                  
                  {quickMessages.length === 0 && (
                    <div className="text-center py-8 text-gray-500">
                      <i className="fas fa-comment-slash text-3xl mb-2"></i>
                      <p>Nenhuma mensagem rápida criada</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Users Tab */}
        {activeTab === "users" && (
          <div className="bg-white rounded-lg shadow">
            <div className="p-6 border-b border-gray-200">
              <div className="flex justify-between items-center">
                <h3 className="text-lg font-semibold text-gray-900">Gerenciar Usuários</h3>
                <button
                  onClick={() => setShowCreateAgent(true)}
                  className="inline-flex items-center px-3 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-whatsapp-600 hover:bg-whatsapp-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-whatsapp-500"
                >
                  <i className="fas fa-plus mr-2"></i>
                  Novo Agente
                </button>
              </div>
            </div>
            <div className="p-6">
              <div className="space-y-4">
                {users.map((user: any) => (
                  <div key={user.id} className="flex items-center justify-between p-4 border border-gray-200 rounded-lg">
                    <div className="flex-1">
                      <p className="font-medium text-gray-900">{user.username}</p>
                      <p className="text-sm text-gray-600">{user.email}</p>
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        user.role === 'admin' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'
                      }`}>
                        {user.role === 'admin' ? 'Administrador' : 'Agente'}
                      </span>
                    </div>
                    <div className="flex items-center space-x-4">
                      <div className="text-sm text-gray-500">
                        {user.lastLogin ? new Date(user.lastLogin).toLocaleDateString() : 'Nunca logou'}
                      </div>
                      {user.role !== 'admin' && (
                        <button
                          onClick={() => handleDeleteUser(user.id, user.username)}
                          disabled={deleteUserMutation.isPending}
                          className="inline-flex items-center px-3 py-1 border border-transparent text-sm font-medium rounded-md text-red-700 bg-red-100 hover:bg-red-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50"
                        >
                          <i className="fas fa-trash mr-1"></i>
                          Excluir
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Agents Status Tab */}
        {activeTab === "agents-status" && (
          <div className="space-y-6">
            {/* Real-time Agent Status Overview */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <div className="w-3 h-3 bg-green-400 rounded-full"></div>
                  </div>
                  <div className="ml-3">
                    <p className="text-sm text-gray-600">Agentes Online</p>
                    <p className="text-2xl font-semibold text-gray-900">
                      {agents.filter((agent: any) => agent.status === "online" && agent.type === "human").length}
                    </p>
                  </div>
                </div>
              </div>
              
              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <div className="w-3 h-3 bg-yellow-400 rounded-full"></div>
                  </div>
                  <div className="ml-3">
                    <p className="text-sm text-gray-600">Agentes Ocupados</p>
                    <p className="text-2xl font-semibold text-gray-900">
                      {agents.filter((agent: any) => agent.status === "busy" && agent.type === "human").length}
                    </p>
                  </div>
                </div>
              </div>
              
              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <div className="w-3 h-3 bg-gray-400 rounded-full"></div>
                  </div>
                  <div className="ml-3">
                    <p className="text-sm text-gray-600">Agentes Offline</p>
                    <p className="text-2xl font-semibold text-gray-900">
                      {agents.filter((agent: any) => agent.status === "offline" && agent.type === "human").length}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Detailed Agent Status Table */}
            <div className="bg-white rounded-lg shadow">
              <div className="p-6 border-b border-gray-200">
                <h3 className="text-lg font-semibold text-gray-900 flex items-center">
                  <i className="fas fa-users mr-2"></i>
                  Status dos Agentes em Tempo Real
                  <span className="ml-2 text-xs bg-green-100 text-green-600 px-2 py-1 rounded-full">
                    Atualiza a cada 5s
                  </span>
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Agente
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Status
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Conversas Ativas
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Total de Conversas
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Última Atividade
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Último Heartbeat
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {agents
                      .filter((agent: any) => agent.type === "human")
                      .map((agent: any) => {
                        const getStatusColor = (status: string) => {
                          switch (status) {
                            case "online":
                              return "bg-green-100 text-green-800";
                            case "busy":
                              return "bg-yellow-100 text-yellow-800";
                            case "offline":
                            default:
                              return "bg-gray-100 text-gray-800";
                          }
                        };

                        const getStatusIcon = (status: string) => {
                          switch (status) {
                            case "online":
                              return "fas fa-circle text-green-400";
                            case "busy":
                              return "fas fa-circle text-yellow-400";
                            case "offline":
                            default:
                              return "fas fa-circle text-gray-400";
                          }
                        };

                        const formatLastActivity = (date: string | null) => {
                          if (!date) return "Nunca";
                          const now = new Date();
                          const lastActivity = new Date(date);
                          const diffInMinutes = Math.floor((now.getTime() - lastActivity.getTime()) / (1000 * 60));
                          
                          if (diffInMinutes < 1) return "Agora";
                          if (diffInMinutes < 60) return `${diffInMinutes}min atrás`;
                          if (diffInMinutes < 1440) return `${Math.floor(diffInMinutes / 60)}h atrás`;
                          return lastActivity.toLocaleDateString("pt-BR");
                        };

                        return (
                          <tr key={agent.id} data-testid={`agent-status-${agent.name}`}>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="flex items-center">
                                <div className="w-10 h-10 bg-gray-300 rounded-full flex items-center justify-center">
                                  <i className="fas fa-user text-gray-600"></i>
                                </div>
                                <div className="ml-4">
                                  <div className="text-sm font-medium text-gray-900">
                                    {agent.name}
                                  </div>
                                  <div className="text-sm text-gray-500">
                                    {agent.email}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(agent.status)}`}>
                                <i className={`${getStatusIcon(agent.status)} mr-1.5 text-xs`}></i>
                                {agent.status === "online" ? "Online" : 
                                 agent.status === "busy" ? "Ocupado" : "Offline"}
                              </span>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              <span className="font-medium">{agent.activeConversations}</span>
                              <span className="text-gray-500 ml-1">/ 5</span>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              {agent.totalConversations}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                              {formatLastActivity(agent.lastActivity)}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                              {formatLastActivity(agent.lastHeartbeat)}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ChatGPT Bot Status */}
            <div className="bg-white rounded-lg shadow">
              <div className="p-6 border-b border-gray-200">
                <h3 className="text-lg font-semibold text-gray-900 flex items-center">
                  <i className="fas fa-robot mr-2"></i>
                  Status do Bot ChatGPT
                </h3>
              </div>
              <div className="p-6">
                {agents.filter((agent: any) => agent.type === "bot").map((bot: any) => (
                  <div key={bot.id} className="flex items-center justify-between p-4 border border-gray-200 rounded-lg">
                    <div className="flex items-center space-x-4">
                      <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center">
                        <i className="fas fa-robot text-blue-600 text-xl"></i>
                      </div>
                      <div>
                        <h4 className="font-medium text-gray-900">{bot.name}</h4>
                        <p className="text-sm text-gray-500">Bot de Atendimento Automatizado</p>
                      </div>
                    </div>
                    <div className="flex items-center space-x-6">
                      <div className="text-center">
                        <p className="text-sm text-gray-500">Status</p>
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                          <i className="fas fa-circle text-green-400 mr-1.5 text-xs"></i>
                          Ativo
                        </span>
                      </div>
                      <div className="text-center">
                        <p className="text-sm text-gray-500">Conversas Atendidas</p>
                        <p className="text-lg font-semibold text-gray-900">{bot.totalConversations}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Reports Tab */}
        {activeTab === "reports" && (
          <div className="bg-white rounded-lg shadow">
            <div className="p-6 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Gerar Relatórios</h3>
            </div>
            <div className="p-6">
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Data Início
                    </label>
                    <input
                      type="date"
                      value={reportRange.startDate}
                      onChange={(e) => setReportRange(prev => ({ ...prev, startDate: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-whatsapp-500 focus:border-whatsapp-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Data Fim
                    </label>
                    <input
                      type="date"
                      value={reportRange.endDate}
                      onChange={(e) => setReportRange(prev => ({ ...prev, endDate: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-whatsapp-500 focus:border-whatsapp-500"
                    />
                  </div>
                </div>
                
                <button
                  onClick={handleGenerateReport}
                  disabled={generateReportMutation.isPending}
                  className="w-full inline-flex justify-center items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
                >
                  {generateReportMutation.isPending ? (
                    <>
                      <i className="fas fa-spinner fa-spin mr-2"></i>
                      Gerando...
                    </>
                  ) : (
                    <>
                      <i className="fas fa-chart-bar mr-2"></i>
                      Gerar Relatório
                    </>
                  )}
                </button>

                <div className="mt-6">
                  <h4 className="text-sm font-medium text-gray-900 mb-3">Relatórios Recentes</h4>
                  <div className="space-y-2">
                    {reports.slice(0, 5).map((report: any) => (
                      <div key={report.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                        <div>
                          <p className="text-sm font-medium text-gray-900">
                            Relatório {report.type}
                          </p>
                          <p className="text-xs text-gray-500">
                            {new Date(report.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                        <button className="text-blue-600 hover:text-blue-800 text-sm">
                          <i className="fas fa-download"></i>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Audit Tab */}
        {activeTab === "audit" && (
          <div className="bg-white rounded-lg shadow">
            <div className="p-6 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Auditoria do Sistema</h3>
              <p className="mt-1 text-sm text-gray-600">
                Registro de todas as ações administrativas e eventos do sistema
              </p>
            </div>
            <div className="p-6">
              {auditLogs && auditLogs.length > 0 ? (
                <div className="space-y-3">
                  {auditLogs.map((log: any) => (
                    <div key={log.id} className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center space-x-2">
                            <span className="text-sm font-medium text-gray-900">{log.action}</span>
                            <span className="text-xs text-gray-500">•</span>
                            <span className="text-xs text-gray-500">{log.entityType}</span>
                            {log.entityId && (
                              <>
                                <span className="text-xs text-gray-500">•</span>
                                <span className="text-xs text-gray-500">{log.entityId}</span>
                              </>
                            )}
                          </div>
                          <div className="mt-1 text-sm text-gray-600">
                            Usuário: {log.userId === 'system' ? 'Sistema' : log.userId}
                          </div>
                          {log.details && (
                            <div className="mt-2">
                              <details className="text-xs">
                                <summary className="cursor-pointer text-blue-600 hover:text-blue-800">
                                  Ver Detalhes
                                </summary>
                                <pre className="mt-2 p-2 bg-gray-100 rounded overflow-auto text-xs">
                                  {JSON.stringify(log.details, null, 2)}
                                </pre>
                              </details>
                            </div>
                          )}
                        </div>
                        <div className="ml-4 text-xs text-gray-500 whitespace-nowrap">
                          {new Date(log.createdAt).toLocaleString('pt-BR')}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12">
                  <i className="fas fa-clipboard-list text-gray-300 text-5xl mb-4"></i>
                  <p className="text-gray-500">Nenhum registro de auditoria encontrado</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Export Tab */}
        {activeTab === "export" && (
          <div className="space-y-6">
            {/* Export Conversations Section */}
            <div className="bg-white rounded-lg shadow">
              <div className="p-6 border-b border-gray-200">
                <div className="flex items-center">
                  <i className="fas fa-download text-green-500 text-xl mr-3"></i>
                  <h3 className="text-lg font-semibold text-gray-900">Exportar Conversas para Excel</h3>
                </div>
                <p className="mt-1 text-sm text-gray-600">
                  Exportar dados detalhados de conversas para análise em planilha.
                </p>
              </div>
              <div className="p-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Data de Início
                    </label>
                    <input
                      type="date"
                      value={exportRange.startDate}
                      onChange={(e) => setExportRange(prev => ({ ...prev, startDate: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
                      data-testid="export-start-date"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Data de Fim
                    </label>
                    <input
                      type="date"
                      value={exportRange.endDate}
                      onChange={(e) => setExportRange(prev => ({ ...prev, endDate: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
                      data-testid="export-end-date"
                    />
                  </div>
                  <div className="flex items-end">
                    <button
                      onClick={exportConversations}
                      className="w-full bg-whatsapp-500 text-white px-4 py-2 rounded-md hover:bg-whatsapp-600 transition-colors"
                      data-testid="button-export-conversations"
                    >
                      <i className="fas fa-file-excel mr-2"></i>
                      Exportar para Excel
                    </button>
                  </div>
                </div>
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <h4 className="text-sm font-medium text-blue-900 mb-2">Dados incluídos no relatório:</h4>
                  <ul className="text-sm text-blue-800 space-y-1">
                    <li>• ID da Conversa, Cliente, Telefone, Agente</li>
                    <li>• Data/hora de início e fim, status da conversa</li>
                    <li>• Tempo total e tempo de espera</li>
                    <li>• Indicação se foi finalizada por inatividade</li>
                    <li>• Prioridade e total de mensagens</li>
                  </ul>
                </div>
              </div>
            </div>

            {/* Top Customers Statistics */}
            <div className="bg-white rounded-lg shadow">
              <div className="p-6 border-b border-gray-200">
                <div className="flex items-center justify-between">
                  <div className="flex items-center">
                    <i className="fas fa-chart-bar text-blue-500 text-xl mr-3"></i>
                    <h3 className="text-lg font-semibold text-gray-900">Clientes Mais Ativos</h3>
                  </div>
                  <div className="flex items-center space-x-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Período (dias)
                      </label>
                      <select
                        value={topCustomersFilter.days}
                        onChange={(e) => setTopCustomersFilter(prev => ({ ...prev, days: parseInt(e.target.value) }))}
                        className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
                        data-testid="select-period"
                      >
                        <option value={7}>7 dias</option>
                        <option value={15}>15 dias</option>
                        <option value={30}>30 dias</option>
                        <option value={60}>60 dias</option>
                        <option value={90}>90 dias</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Métrica
                      </label>
                      <select
                        value={topCustomersFilter.metric}
                        onChange={(e) => setTopCustomersFilter(prev => ({ ...prev, metric: e.target.value }))}
                        className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
                        data-testid="select-metric"
                      >
                        <option value="conversations">Quantidade de Conversas</option>
                        <option value="time">Tempo Total em Conversas</option>
                      </select>
                    </div>
                  </div>
                </div>
                <p className="mt-1 text-sm text-gray-600">
                  Top 10 clientes que mais utilizaram o WhatsApp nos últimos {topCustomersFilter.days} dias
                </p>
              </div>
              <div className="p-6">
                {topCustomers.customers.length > 0 ? (
                  <div className="space-y-4">
                    {/* Chart */}
                    <div className="h-80">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={topCustomers.customers}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis 
                            dataKey="customerName" 
                            angle={-45}
                            textAnchor="end"
                            height={80}
                            fontSize={12}
                          />
                          <YAxis />
                          <Tooltip 
                            formatter={(value, name) => [
                              topCustomersFilter.metric === 'time' 
                                ? `${value} min` 
                                : value,
                              topCustomersFilter.metric === 'time' 
                                ? 'Tempo Total' 
                                : 'Conversas'
                            ]}
                            labelFormatter={(label) => `Cliente: ${label}`}
                          />
                          <Bar 
                            dataKey={topCustomersFilter.metric === 'time' ? 'totalTimeMinutes' : 'conversationCount'}
                            fill="#25D366"
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    
                    {/* Table */}
                    <div className="overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Cliente
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Telefone
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Conversas
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Tempo Total (min)
                            </th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {topCustomers.customers.map((customer: any, index: number) => (
                            <tr key={index} className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                              <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                                {customer.customerName}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                {customer.customerPhone}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                {customer.conversationCount}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                {Math.round(customer.totalTimeMinutes)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <i className="fas fa-chart-bar text-gray-400 text-4xl mb-4"></i>
                    <p className="text-gray-500">Nenhum dado disponível para o período selecionado</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Settings Tab */}
        {activeTab === "settings" && (
          <div className="space-y-6">
            {/* ChatGPT Priority Settings */}
            <div className="bg-white rounded-lg shadow">
              <div className="p-6 border-b border-gray-200">
                <div className="flex items-center">
                  <i className="fas fa-robot text-blue-500 text-xl mr-3"></i>
                  <h3 className="text-lg font-semibold text-gray-900">Configurações do ChatGPT</h3>
                </div>
                <p className="mt-1 text-sm text-gray-600">
                  Controle como o ChatGPT interage com as conversas e sua prioridade no atendimento.
                </p>
              </div>
              <div className="p-6">
                <div className="space-y-4">
                  {/* ChatGPT Priority Toggle */}
                  <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border">
                    <div className="flex items-center space-x-3">
                      <div className={`w-3 h-3 rounded-full ${chatGPTPriorityEnabled ? 'bg-green-500' : 'bg-gray-400'}`}></div>
                      <div>
                        <h4 className="text-sm font-medium text-gray-900">
                          Modo de Prioridade do ChatGPT
                        </h4>
                        <p className="text-sm text-gray-600">
                          Quando habilitado, o ChatGPT terá prioridade sobre agentes humanos na distribuição de conversas
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center space-x-3">
                      <span className={`text-sm font-medium ${chatGPTPriorityEnabled ? 'text-green-600' : 'text-gray-500'}`}>
                        {chatGPTPriorityEnabled ? 'Habilitado' : 'Desabilitado'}
                      </span>
                      <button
                        onClick={() => toggleChatGPTPriorityMutation.mutate(!chatGPTPriorityEnabled)}
                        disabled={toggleChatGPTPriorityMutation.isPending}
                        className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-whatsapp-500 focus:ring-offset-2 ${
                          chatGPTPriorityEnabled ? 'bg-whatsapp-600' : 'bg-gray-200'
                        } disabled:opacity-50`}
                        data-testid="toggle-chatgpt-priority"
                      >
                        <span
                          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                            chatGPTPriorityEnabled ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </div>
                  </div>

                  {/* Status Information */}
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <div className="flex">
                      <i className="fas fa-info-circle text-blue-500 mt-0.5 mr-3"></i>
                      <div className="text-sm">
                        <p className="text-blue-800 font-medium mb-1">Como funciona:</p>
                        <ul className="text-blue-700 space-y-1 text-sm">
                          <li>• <strong>Desabilitado:</strong> ChatGPT responde apenas mensagens que considera simples</li>
                          <li>• <strong>Habilitado:</strong> ChatGPT recebe todas as novas conversas, mesmo com agentes humanos online</li>
                          <li>• Agentes humanos ainda podem assumir conversas manualmente</li>
                          <li>• ChatGPT pode transferir conversas complexas para agentes humanos</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Hybrid WhatsApp Strategy Status */}
            <div className="bg-white rounded-lg shadow">
              <div className="p-6 border-b border-gray-200">
                <div className="flex items-center justify-between">
                  <div className="flex items-center">
                    <i className="fas fa-network-wired text-purple-500 text-xl mr-3"></i>
                    <h3 className="text-lg font-semibold text-gray-900">Estratégia Híbrida WhatsApp</h3>
                  </div>
                  {hybridStatus && (
                    <div className="flex items-center space-x-2">
                      {hybridStatus.activeProvider === 'evolution' && (
                        <>
                          <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
                          <span className="text-sm font-medium text-green-600">Evolution API Ativa</span>
                        </>
                      )}
                      {hybridStatus.activeProvider === 'official' && (
                        <>
                          <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse"></div>
                          <span className="text-sm font-medium text-blue-600">API Oficial Ativa</span>
                        </>
                      )}
                      {hybridStatus.activeProvider === 'simulation' && (
                        <>
                          <div className="w-3 h-3 bg-yellow-500 rounded-full"></div>
                          <span className="text-sm font-medium text-yellow-600">Modo Simulação</span>
                        </>
                      )}
                      {hybridStatus.activeProvider === 'none' && (
                        <>
                          <div className="w-3 h-3 bg-gray-500 rounded-full"></div>
                          <span className="text-sm font-medium text-gray-600">Nenhuma API Ativa</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <p className="mt-1 text-sm text-gray-600">
                  Sistema inteligente com fallback automático entre Evolution API (grátis), API Oficial (paga) e Simulação
                </p>
              </div>

              <div className="p-6">
                {/* Provider Status Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                  {/* Evolution API Card */}
                  <div 
                    className={`border-2 rounded-lg p-4 ${
                      hybridStatus?.evolution.configured && hybridStatus?.evolution.connected
                        ? 'border-green-500 bg-green-50'
                        : hybridStatus?.evolution.configured
                        ? 'border-yellow-500 bg-yellow-50'
                        : 'border-gray-300 bg-gray-50'
                    }`}
                    data-testid="card-hybrid-evolution"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="font-semibold text-gray-900">Evolution API</h4>
                      {hybridStatus?.activeProvider === 'evolution' && (
                        <span className="text-xs bg-green-600 text-white px-2 py-1 rounded-full" data-testid="badge-active-evolution">ATIVA</span>
                      )}
                    </div>
                    <div className="space-y-1 text-sm">
                      <div className="flex items-center">
                        <i className={`fas fa-circle mr-2 ${
                          hybridStatus?.evolution.configured ? 'text-green-500' : 'text-gray-400'
                        }`} style={{ fontSize: '8px' }}></i>
                        <span>Configurada: {hybridStatus?.evolution.configured ? 'Sim' : 'Não'}</span>
                      </div>
                      <div className="flex items-center">
                        <i className={`fas fa-circle mr-2 ${
                          hybridStatus?.evolution.connected ? 'text-green-500' : 'text-gray-400'
                        }`} style={{ fontSize: '8px' }}></i>
                        <span>Conectada: {hybridStatus?.evolution.connected ? 'Sim' : 'Não'}</span>
                      </div>
                      {hybridStatus?.evolution.instanceName && (
                        <div className="text-xs text-gray-600 mt-2">
                          Instância: {hybridStatus.evolution.instanceName}
                        </div>
                      )}
                    </div>
                    <div className="mt-3 text-xs font-medium text-purple-600">
                      💰 Grátis • 🚀 Prioridade 1
                    </div>
                  </div>

                  {/* Official API Card */}
                  <div 
                    className={`border-2 rounded-lg p-4 ${
                      hybridStatus?.official.configured
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-300 bg-gray-50'
                    }`}
                    data-testid="card-hybrid-official"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="font-semibold text-gray-900">API Oficial</h4>
                      {hybridStatus?.activeProvider === 'official' && (
                        <span className="text-xs bg-blue-600 text-white px-2 py-1 rounded-full" data-testid="badge-active-official">ATIVA</span>
                      )}
                    </div>
                    <div className="space-y-1 text-sm">
                      <div className="flex items-center">
                        <i className={`fas fa-circle mr-2 ${
                          hybridStatus?.official.configured ? 'text-green-500' : 'text-gray-400'
                        }`} style={{ fontSize: '8px' }}></i>
                        <span>Configurada: {hybridStatus?.official.configured ? 'Sim' : 'Não'}</span>
                      </div>
                      {hybridStatus?.official.phoneNumberId && (
                        <div className="text-xs text-gray-600 mt-2">
                          ID: {hybridStatus.official.phoneNumberId}
                        </div>
                      )}
                    </div>
                    <div className="mt-3 text-xs font-medium text-blue-600">
                      💳 Pago • 🔄 Fallback Prioridade 2
                    </div>
                  </div>

                  {/* Simulation Card */}
                  <div 
                    className={`border-2 rounded-lg p-4 ${
                      hybridStatus?.simulation.status === 'connected'
                        ? 'border-yellow-500 bg-yellow-50'
                        : 'border-gray-300 bg-gray-50'
                    }`}
                    data-testid="card-hybrid-simulation"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="font-semibold text-gray-900">Simulação</h4>
                      {hybridStatus?.activeProvider === 'simulation' && (
                        <span className="text-xs bg-yellow-600 text-white px-2 py-1 rounded-full" data-testid="badge-active-simulation">ATIVA</span>
                      )}
                    </div>
                    <div className="space-y-1 text-sm">
                      <div className="flex items-center">
                        <i className={`fas fa-circle mr-2 ${
                          hybridStatus?.simulation.status === 'connected' ? 'text-green-500' : 'text-gray-400'
                        }`} style={{ fontSize: '8px' }}></i>
                        <span>Status: {hybridStatus?.simulation.status || 'Desconectado'}</span>
                      </div>
                      {hybridStatus?.simulation.phoneNumber && (
                        <div className="text-xs text-gray-600 mt-2">
                          {hybridStatus.simulation.phoneNumber}
                        </div>
                      )}
                    </div>
                    <div className="mt-3 text-xs font-medium text-yellow-600">
                      🧪 Teste • 🔄 Fallback Prioridade 3
                    </div>
                  </div>
                </div>

                {/* How it Works Info */}
                <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                  <div className="flex">
                    <i className="fas fa-info-circle text-purple-500 mt-0.5 mr-3"></i>
                    <div className="text-sm">
                      <p className="text-purple-800 font-medium mb-2">Como funciona a estratégia híbrida:</p>
                      <ul className="text-purple-700 space-y-1">
                        <li>• <strong>Prioridade 1:</strong> Evolution API (grátis) - se configurada e conectada</li>
                        <li>• <strong>Prioridade 2:</strong> WhatsApp Business API Oficial (paga) - fallback automático</li>
                        <li>• <strong>Prioridade 3:</strong> Modo Simulação - último fallback para testes</li>
                        <li>• <strong>Automático:</strong> O sistema escolhe automaticamente a melhor opção disponível</li>
                        <li>• <strong>Resiliência:</strong> Se uma falhar, tenta a próxima automaticamente</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Evolution API Settings */}
            <div className="bg-white rounded-lg shadow">
              <div className="p-6 border-b border-gray-200">
                <div className="flex items-center justify-between">
                  <div className="flex items-center">
                    <i className="fas fa-rocket text-purple-500 text-xl mr-3"></i>
                    <h3 className="text-lg font-semibold text-gray-900">Evolution API (Grátis)</h3>
                  </div>
                  <div className="flex items-center space-x-2">
                    {evolutionStatus?.isConfigured ? (
                      <>
                        {evolutionStatus.connected ? (
                          <>
                            <div className="w-3 h-3 bg-green-500 rounded-full"></div>
                            <span className="text-sm font-medium text-green-600">Conectada</span>
                          </>
                        ) : (
                          <>
                            <div className="w-3 h-3 bg-yellow-500 rounded-full"></div>
                            <span className="text-sm font-medium text-yellow-600">Configurada</span>
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        <div className="w-3 h-3 bg-red-500 rounded-full"></div>
                        <span className="text-sm font-medium text-red-600">Não Configurada</span>
                      </>
                    )}
                  </div>
                </div>
                <p className="mt-1 text-sm text-gray-600">
                  Evolution API é uma alternativa <strong>gratuita e open-source</strong> para integração com WhatsApp via QR Code.
                </p>
              </div>

              <div className="p-6">
                {/* Current Status */}
                {evolutionStatus?.isConfigured && (
                  <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 mb-6">
                    <div className="flex items-start">
                      <i className="fas fa-check-circle text-purple-500 mt-0.5 mr-3"></i>
                      <div className="text-sm">
                        <p className="text-purple-800 font-medium mb-2">Configuração Atual:</p>
                        <ul className="text-purple-700 space-y-1">
                          <li>• <strong>API URL:</strong> {evolutionStatus.apiUrl}</li>
                          <li>• <strong>Instância:</strong> {evolutionStatus.instanceName}</li>
                          <li>• <strong>Status:</strong> {evolutionStatus.connected ? '✅ Conectada' : '⚠️ Desconectada'}</li>
                        </ul>
                        <div className="mt-3 flex gap-2">
                          <button
                            onClick={() => testEvolutionMutation.mutate()}
                            disabled={testEvolutionMutation.isPending}
                            className="bg-purple-600 text-white px-4 py-2 rounded-md hover:bg-purple-700 transition-colors disabled:opacity-50 text-sm"
                            data-testid="button-test-evolution-connection"
                          >
                            {testEvolutionMutation.isPending ? (
                              <>
                                <i className="fas fa-spinner fa-spin mr-2"></i>
                                Testando...
                              </>
                            ) : (
                              <>
                                <i className="fas fa-check mr-2"></i>
                                Testar Conexão
                              </>
                            )}
                          </button>
                          {!evolutionStatus.connected && (
                            <button
                              onClick={() => connectEvolutionMutation.mutate()}
                              disabled={connectEvolutionMutation.isPending}
                              className="bg-green-600 text-white px-4 py-2 rounded-md hover:bg-green-700 transition-colors disabled:opacity-50 text-sm"
                              data-testid="button-connect-evolution-qr"
                            >
                              {connectEvolutionMutation.isPending ? (
                                <>
                                  <i className="fas fa-spinner fa-spin mr-2"></i>
                                  Conectando...
                                </>
                              ) : (
                                <>
                                  <i className="fas fa-qrcode mr-2"></i>
                                  Conectar QR Code
                                </>
                              )}
                            </button>
                          )}
                          {evolutionStatus.connected && (
                            <>
                              <button
                                onClick={() => reconfigureWebhookMutation.mutate()}
                                disabled={reconfigureWebhookMutation.isPending}
                                className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 text-sm"
                                data-testid="button-reconfigure-webhook"
                              >
                                {reconfigureWebhookMutation.isPending ? (
                                  <>
                                    <i className="fas fa-spinner fa-spin mr-2"></i>
                                    Reconfigurando...
                                  </>
                                ) : (
                                  <>
                                    <i className="fas fa-sync-alt mr-2"></i>
                                    Reconfigurar Webhook
                                  </>
                                )}
                              </button>
                              <button
                                onClick={() => disconnectEvolutionMutation.mutate()}
                                disabled={disconnectEvolutionMutation.isPending}
                                className="bg-red-600 text-white px-4 py-2 rounded-md hover:bg-red-700 transition-colors disabled:opacity-50 text-sm"
                                data-testid="button-disconnect-evolution"
                              >
                                {disconnectEvolutionMutation.isPending ? (
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
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Configuration Form */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-md font-medium text-gray-900">
                      {evolutionStatus?.isConfigured ? 'Atualizar Configuração' : 'Configurar Evolution API'}
                    </h4>
                    {!showEvolutionConfig && (
                      <button
                        onClick={() => setShowEvolutionConfig(true)}
                        className="text-purple-600 hover:text-purple-800 text-sm"
                        data-testid="button-show-evolution-form"
                      >
                        <i className="fas fa-edit mr-1"></i>
                        {evolutionStatus?.isConfigured ? 'Editar' : 'Configurar'}
                      </button>
                    )}
                  </div>

                  {showEvolutionConfig && (
                    <form onSubmit={(e) => {
                      e.preventDefault();
                      if (!evolutionConfig.apiUrl || !evolutionConfig.apiKey || !evolutionConfig.instanceName) {
                        toast({
                          title: "Erro",
                          description: "Todos os campos são obrigatórios",
                          variant: "destructive",
                        });
                        return;
                      }
                      configureEvolutionMutation.mutate(evolutionConfig);
                    }} className="space-y-4 border border-gray-200 rounded-lg p-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          URL da API Evolution *
                        </label>
                        <input
                          type="url"
                          value={evolutionConfig.apiUrl}
                          onChange={(e) => setEvolutionConfig(prev => ({ ...prev, apiUrl: e.target.value }))}
                          placeholder="https://sua-evolution-api.com"
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                          data-testid="input-evolution-api-url"
                          required
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          URL completa do servidor Evolution API (sem barra no final)
                        </p>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          API Key *
                        </label>
                        <input
                          type="password"
                          value={evolutionConfig.apiKey}
                          onChange={(e) => setEvolutionConfig(prev => ({ ...prev, apiKey: e.target.value }))}
                          placeholder="B6D711FCDE4D4FD5936544120E713976"
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                          data-testid="input-evolution-api-key"
                          required
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          Chave de autenticação da API (definida no servidor Evolution)
                        </p>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Nome da Instância *
                        </label>
                        <input
                          type="text"
                          value={evolutionConfig.instanceName}
                          onChange={(e) => setEvolutionConfig(prev => ({ ...prev, instanceName: e.target.value }))}
                          placeholder="atendimento"
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                          data-testid="input-evolution-instance-name"
                          required
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          Nome único para identificar esta instância (use letras minúsculas sem espaços)
                        </p>
                      </div>

                      <div className="flex items-center space-x-3">
                        <button
                          type="submit"
                          disabled={configureEvolutionMutation.isPending}
                          className="bg-purple-600 text-white px-4 py-2 rounded-md hover:bg-purple-700 transition-colors disabled:opacity-50"
                          data-testid="button-save-evolution-config"
                        >
                          {configureEvolutionMutation.isPending ? (
                            <>
                              <i className="fas fa-spinner fa-spin mr-2"></i>
                              Salvando...
                            </>
                          ) : (
                            <>
                              <i className="fas fa-save mr-2"></i>
                              Salvar Configuração
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowEvolutionConfig(false);
                            setEvolutionConfig({ apiUrl: '', apiKey: '', instanceName: '' });
                          }}
                          className="bg-gray-500 text-white px-4 py-2 rounded-md hover:bg-gray-600 transition-colors"
                          data-testid="button-cancel-evolution-config"
                        >
                          Cancelar
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Instructions */}
                  <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                    <div className="flex">
                      <i className="fas fa-info-circle text-purple-500 mt-0.5 mr-3"></i>
                      <div className="text-sm">
                        <p className="text-purple-800 font-medium mb-2">Como configurar a Evolution API:</p>
                        <ol className="text-purple-700 space-y-1 text-sm list-decimal list-inside">
                          <li>Você precisa ter um servidor Evolution API rodando (pode ser auto-hospedado ou serviço terceiro)</li>
                          <li>Configure a URL da API, API Key e escolha um nome para sua instância</li>
                          <li>Clique em "Salvar Configuração"</li>
                          <li>Depois, clique em "Conectar QR Code" e escaneie com seu WhatsApp</li>
                          <li>Pronto! O sistema começará a usar a Evolution API automaticamente</li>
                        </ol>
                        <p className="text-purple-700 mt-2 text-xs">
                          💡 <strong>Vantagem:</strong> Totalmente gratuito e open-source!
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Chat History Sync */}
                  {evolutionStatusLoading && (
                    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mt-4">
                      <p className="text-gray-600">Carregando status da Evolution API...</p>
                    </div>
                  )}
                  {!evolutionStatusLoading && evolutionStatus?.isConfigured && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mt-4">
                      <div className="flex items-start">
                        <i className="fas fa-info-circle text-blue-500 mt-0.5 mr-3"></i>
                        <div className="flex-1">
                          <p className="text-blue-800 font-medium mb-2">📨 Captura Automática de Mensagens</p>
                          <p className="text-blue-700 text-sm mb-2">
                            <strong>✅ Todas as mensagens futuras são salvas automaticamente!</strong>
                          </p>
                          <p className="text-blue-600 text-sm mb-2">
                            A partir do momento em que o WhatsApp foi conectado, todas as novas conversas e mensagens são capturadas em tempo real e salvas no banco de dados. O sistema está configurado para:
                          </p>
                          <ul className="text-blue-600 text-sm list-disc list-inside space-y-1 mb-3">
                            <li>Receber mensagens instantaneamente via webhook</li>
                            <li>Criar clientes automaticamente quando enviam primeira mensagem</li>
                            <li>Salvar todo histórico de conversas futuras</li>
                            <li>Disponibilizar contexto completo para ChatGPT e agentes</li>
                          </ul>
                          <div className="bg-amber-50 border border-amber-200 rounded-md p-3">
                            <p className="text-amber-800 text-sm">
                              <i className="fas fa-exclamation-triangle mr-2"></i>
                              <strong>Importante:</strong> Mensagens antigas (anteriores à conexão) não podem ser recuperadas pela limitação técnica da API Evolution. Apenas conversas novas são salvas.
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                  {!evolutionStatusLoading && !evolutionStatus?.isConfigured && (
                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mt-4">
                      <p className="text-yellow-800 text-sm">
                        Configure a Evolution API acima para habilitar a sincronização de histórico.
                      </p>
                    </div>
                  )}

                  {/* Webhook Status Diagnostic */}
                  {evolutionStatus?.isConfigured && (
                    <div className={`border rounded-lg p-4 mt-4 ${
                      webhookStatus?.success && webhookStatus.webhookUrl === 'https://chathonest.replit.app/api/evolution/webhook'
                        ? 'bg-green-50 border-green-200'
                        : 'bg-red-50 border-red-200'
                    }`}>
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <p className={`font-medium mb-2 ${
                            webhookStatus?.success && webhookStatus.webhookUrl === 'https://chathonest.replit.app/api/evolution/webhook'
                              ? 'text-green-800'
                              : 'text-red-800'
                          }`}>
                            <i className={`fas ${
                              webhookStatus?.success && webhookStatus.webhookUrl === 'https://chathonest.replit.app/api/evolution/webhook'
                                ? 'fa-check-circle'
                                : 'fa-exclamation-triangle'
                            } mr-2`}></i>
                            Status do Webhook
                          </p>
                          {!webhookStatus ? (
                            <p className="text-gray-600 text-sm">
                              <i className="fas fa-spinner fa-spin mr-2"></i>
                              Verificando configuração do webhook...
                            </p>
                          ) : webhookStatus.success ? (
                            <>
                              <p className={`text-sm mb-2 ${
                                webhookStatus.webhookUrl === 'https://chathonest.replit.app/api/evolution/webhook'
                                  ? 'text-green-700'
                                  : 'text-red-700'
                              }`}>
                                <strong>URL Configurada:</strong> {webhookStatus.webhookUrl || 'Não configurada'}
                              </p>
                              <p className={`text-sm mb-2 ${
                                webhookStatus.webhookUrl === 'https://chathonest.replit.app/api/evolution/webhook'
                                  ? 'text-green-700'
                                  : 'text-red-700'
                              }`}>
                                <strong>Eventos:</strong> {webhookStatus.events?.join(', ') || 'Nenhum'}
                              </p>
                              {webhookStatus.webhookUrl === 'https://chathonest.replit.app/api/evolution/webhook' && (
                                <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-md">
                                  <p className="text-amber-800 text-sm mb-2">
                                    ⚠️ <strong>Webhooks não estão chegando?</strong>
                                  </p>
                                  <p className="text-amber-700 text-xs mb-3">
                                    Se mensagens não aparecem em tempo real, tente reiniciar a conexão. Isso vai desconectar e reconectar o WhatsApp, reativando os webhooks.
                                  </p>
                                  <button
                                    onClick={() => restartConnectionMutation.mutate()}
                                    disabled={restartConnectionMutation.isPending}
                                    className="w-full px-4 py-2 bg-amber-600 text-white rounded-md hover:bg-amber-700 disabled:opacity-50 text-sm"
                                    data-testid="button-restart-connection"
                                  >
                                    {restartConnectionMutation.isPending ? (
                                      <>
                                        <i className="fas fa-spinner fa-spin mr-2"></i>
                                        Reiniciando...
                                      </>
                                    ) : (
                                      <>
                                        <i className="fas fa-sync-alt mr-2"></i>
                                        Reiniciar Conexão WhatsApp
                                      </>
                                    )}
                                  </button>
                                </div>
                              )}
                              {webhookStatus.webhookUrl !== 'https://chathonest.replit.app/api/evolution/webhook' && (
                                <p className="text-red-700 text-sm mt-2">
                                  ⚠️ <strong>Problema:</strong> Webhook está configurado para URL incorreta. Clique em "Corrigir Webhook" para resolver.
                                </p>
                              )}
                            </>
                          ) : (
                            <p className="text-red-700 text-sm">
                              ❌ Erro ao buscar configuração do webhook: {webhookStatus.error}
                            </p>
                          )}
                        </div>
                        {webhookStatus?.success && webhookStatus.webhookUrl !== 'https://chathonest.replit.app/api/evolution/webhook' && (
                          <button
                            onClick={() => fixWebhookMutation.mutate()}
                            disabled={fixWebhookMutation.isPending}
                            className="ml-4 px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 text-sm"
                            data-testid="button-fix-webhook"
                          >
                            {fixWebhookMutation.isPending ? 'Corrigindo...' : 'Corrigir Webhook'}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* WhatsApp Official API Settings */}
            <div className="bg-white rounded-lg shadow">
              <div className="p-6 border-b border-gray-200">
                <div className="flex items-center justify-between">
                  <div className="flex items-center">
                    <i className="fas fa-whatsapp text-green-500 text-xl mr-3"></i>
                    <h3 className="text-lg font-semibold text-gray-900">API Oficial do WhatsApp</h3>
                  </div>
                  <div className="flex items-center space-x-2">
                    {whatsappStatus?.isConfigured ? (
                      <>
                        <div className="w-3 h-3 bg-green-500 rounded-full"></div>
                        <span className="text-sm font-medium text-green-600">Configurada</span>
                      </>
                    ) : (
                      <>
                        <div className="w-3 h-3 bg-red-500 rounded-full"></div>
                        <span className="text-sm font-medium text-red-600">Não Configurada</span>
                      </>
                    )}
                  </div>
                </div>
                <p className="mt-1 text-sm text-gray-600">
                  Configure sua API oficial do WhatsApp Business para enviar e receber mensagens reais.
                </p>
              </div>

              <div className="p-6">
                {/* Current Configuration Status */}
                {whatsappStatus?.isConfigured && (
                  <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
                    <div className="flex items-start">
                      <i className="fas fa-check-circle text-green-500 mt-0.5 mr-3"></i>
                      <div className="text-sm">
                        <p className="text-green-800 font-medium mb-2">Configuração Atual:</p>
                        <ul className="text-green-700 space-y-1">
                          <li>• <strong>Phone Number ID:</strong> {whatsappStatus.phoneNumberId}</li>
                          {whatsappStatus.businessAccountId && (
                            <li>• <strong>Business Account ID:</strong> {whatsappStatus.businessAccountId}</li>
                          )}
                          <li>• <strong>Access Token:</strong> {whatsappStatus.hasAccessToken ? 'Configurado' : 'Não configurado'}</li>
                          <li>• <strong>Webhook Token:</strong> {whatsappStatus.hasWebhookToken ? 'Configurado' : 'Não configurado'}</li>
                        </ul>
                        <div className="mt-3">
                          <button
                            onClick={() => testWhatsAppMutation.mutate()}
                            disabled={testWhatsAppMutation.isPending}
                            className="bg-green-600 text-white px-4 py-2 rounded-md hover:bg-green-700 transition-colors disabled:opacity-50"
                            data-testid="button-test-whatsapp-connection"
                          >
                            {testWhatsAppMutation.isPending ? (
                              <>
                                <i className="fas fa-spinner fa-spin mr-2"></i>
                                Testando...
                              </>
                            ) : (
                              <>
                                <i className="fas fa-check mr-2"></i>
                                Testar Conexão
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Configuration Form */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-md font-medium text-gray-900">
                      {whatsappStatus?.isConfigured ? 'Atualizar Configuração' : 'Configurar API Oficial'}
                    </h4>
                    {!showWhatsappTokens && (
                      <button
                        onClick={() => setShowWhatsappTokens(true)}
                        className="text-blue-600 hover:text-blue-800 text-sm"
                        data-testid="button-show-whatsapp-form"
                      >
                        <i className="fas fa-edit mr-1"></i>
                        {whatsappStatus?.isConfigured ? 'Editar' : 'Configurar'}
                      </button>
                    )}
                  </div>

                  {showWhatsappTokens && (
                    <form onSubmit={(e) => {
                      e.preventDefault();
                      if (!whatsappConfig.accessToken || !whatsappConfig.phoneNumberId || !whatsappConfig.webhookVerifyToken) {
                        toast({
                          title: "Erro",
                          description: "Access Token, Phone Number ID e Webhook Verify Token são obrigatórios",
                          variant: "destructive",
                        });
                        return;
                      }
                      configureWhatsAppMutation.mutate(whatsappConfig);
                    }} className="space-y-4 border border-gray-200 rounded-lg p-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Access Token *
                        </label>
                        <input
                          type="password"
                          value={whatsappConfig.accessToken}
                          onChange={(e) => setWhatsappConfig(prev => ({ ...prev, accessToken: e.target.value }))}
                          placeholder="EAAJpxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
                          data-testid="input-access-token"
                          required
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Phone Number ID *
                        </label>
                        <input
                          type="text"
                          value={whatsappConfig.phoneNumberId}
                          onChange={(e) => setWhatsappConfig(prev => ({ ...prev, phoneNumberId: e.target.value }))}
                          placeholder="123456789012345"
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
                          data-testid="input-phone-number-id"
                          required
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Webhook Verify Token *
                        </label>
                        <input
                          type="text"
                          value={whatsappConfig.webhookVerifyToken}
                          onChange={(e) => setWhatsappConfig(prev => ({ ...prev, webhookVerifyToken: e.target.value }))}
                          placeholder="meu_token_secreto_123"
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
                          data-testid="input-webhook-verify-token"
                          required
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Business Account ID (opcional)
                        </label>
                        <input
                          type="text"
                          value={whatsappConfig.businessAccountId}
                          onChange={(e) => setWhatsappConfig(prev => ({ ...prev, businessAccountId: e.target.value }))}
                          placeholder="123456789012345"
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
                          data-testid="input-business-account-id"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          Necessário apenas para acessar templates de mensagem
                        </p>
                      </div>

                      <div className="flex items-center space-x-3">
                        <button
                          type="submit"
                          disabled={configureWhatsAppMutation.isPending}
                          className="bg-whatsapp-500 text-white px-4 py-2 rounded-md hover:bg-whatsapp-600 transition-colors disabled:opacity-50"
                          data-testid="button-save-whatsapp-config"
                        >
                          {configureWhatsAppMutation.isPending ? (
                            <>
                              <i className="fas fa-spinner fa-spin mr-2"></i>
                              Salvando...
                            </>
                          ) : (
                            <>
                              <i className="fas fa-save mr-2"></i>
                              Salvar Configuração
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowWhatsappTokens(false);
                            setWhatsappConfig({ accessToken: '', phoneNumberId: '', webhookVerifyToken: '', businessAccountId: '' });
                          }}
                          className="bg-gray-500 text-white px-4 py-2 rounded-md hover:bg-gray-600 transition-colors"
                          data-testid="button-cancel-whatsapp-config"
                        >
                          Cancelar
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Instructions */}
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <div className="flex">
                      <i className="fas fa-info-circle text-blue-500 mt-0.5 mr-3"></i>
                      <div className="text-sm">
                        <p className="text-blue-800 font-medium mb-2">Como obter as credenciais:</p>
                        <ol className="text-blue-700 space-y-1 text-sm list-decimal list-inside">
                          <li>Crie uma conta no <strong>Meta for Developers</strong> (developers.facebook.com)</li>
                          <li>Crie um app do tipo <strong>"Business"</strong></li>
                          <li>Adicione o produto <strong>"WhatsApp"</strong> ao seu app</li>
                          <li>Configure um <strong>Business Manager</strong> e adicione seu número</li>
                          <li>Gere um <strong>Access Token</strong> permanente</li>
                          <li>Configure o <strong>Webhook</strong> com a URL: <code className="bg-blue-100 px-1 rounded">https://seuapp.replit.app/api/whatsapp/webhook</code></li>
                        </ol>
                        <p className="text-blue-700 mt-2 text-xs">
                          ⚠️ <strong>Importante:</strong> Use um número dedicado que não esteja sendo usado no WhatsApp pessoal.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Additional Settings */}
            <div className="bg-white rounded-lg shadow">
              <div className="p-6 border-b border-gray-200">
                <div className="flex items-center">
                  <i className="fas fa-cog text-gray-500 text-xl mr-3"></i>
                  <h3 className="text-lg font-semibold text-gray-900">Outras Configurações</h3>
                </div>
                <p className="mt-1 text-sm text-gray-600">
                  Configurações adicionais do sistema estarão disponíveis em breve.
                </p>
              </div>
              <div className="p-6">
                <p className="text-sm text-gray-500 italic">Configurações em desenvolvimento...</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Create Agent Modal */}
      {showCreateAgent && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900">Criar Novo Agente</h3>
                <button
                  onClick={() => setShowCreateAgent(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <i className="fas fa-times"></i>
                </button>
              </div>

              <form onSubmit={handleCreateAgent} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Nome Completo
                  </label>
                  <input
                    type="text"
                    value={newAgent.name}
                    onChange={(e) => setNewAgent(prev => ({ ...prev, name: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-whatsapp-500 focus:border-whatsapp-500"
                    placeholder="João Silva"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Nome de Usuário
                  </label>
                  <input
                    type="text"
                    value={newAgent.username}
                    onChange={(e) => setNewAgent(prev => ({ ...prev, username: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-whatsapp-500 focus:border-whatsapp-500"
                    placeholder="joao.silva"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Email
                  </label>
                  <input
                    type="email"
                    value={newAgent.email}
                    onChange={(e) => setNewAgent(prev => ({ ...prev, email: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-whatsapp-500 focus:border-whatsapp-500"
                    placeholder="joao@empresa.com"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Senha
                  </label>
                  <input
                    type="password"
                    value={newAgent.passwordHash}
                    onChange={(e) => setNewAgent(prev => ({ ...prev, passwordHash: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-whatsapp-500 focus:border-whatsapp-500"
                    placeholder="Senha temporária"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Tipo de Usuário
                  </label>
                  <select
                    value={newAgent.role}
                    onChange={(e) => setNewAgent(prev => ({ ...prev, role: e.target.value as "agent" | "admin" }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-whatsapp-500 focus:border-whatsapp-500"
                    data-testid="select-user-role"
                  >
                    <option value="agent">Atendente</option>
                    <option value="admin">Administrador</option>
                  </select>
                </div>

                <div className="flex space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowCreateAgent(false)}
                    className="flex-1 px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-whatsapp-500"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={createAgentMutation.isPending}
                    className="flex-1 px-4 py-2 bg-whatsapp-600 text-white rounded-md hover:bg-whatsapp-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-whatsapp-500 disabled:opacity-50"
                  >
                    {createAgentMutation.isPending ? (
                      <div className="flex items-center justify-center">
                        <i className="fas fa-spinner fa-spin mr-2"></i>
                        Criando...
                      </div>
                    ) : (
                      "Criar Agente"
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Create Quick Message Modal */}
      {showCreateQuickMessage && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900">Nova Mensagem Rápida</h3>
                <button
                  onClick={() => setShowCreateQuickMessage(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <i className="fas fa-times"></i>
                </button>
              </div>

              <form onSubmit={handleCreateQuickMessage} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Título
                  </label>
                  <input
                    type="text"
                    value={newQuickMessage.title}
                    onChange={(e) => setNewQuickMessage(prev => ({ ...prev, title: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-whatsapp-500 focus:border-whatsapp-500"
                    placeholder="Ex: Boas vindas, Informações de entrega..."
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Tipo da Mensagem
                  </label>
                  <select
                    value={newQuickMessage.messageType}
                    onChange={(e) => setNewQuickMessage(prev => ({ ...prev, messageType: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-whatsapp-500 focus:border-whatsapp-500"
                  >
                    <option value="text">Texto Simples</option>
                    <option value="product_menu">Cardápio de Produtos</option>
                    <option value="order_form">Formulário de Pedido</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Conteúdo
                  </label>
                  <textarea
                    value={newQuickMessage.content}
                    onChange={(e) => setNewQuickMessage(prev => ({ ...prev, content: e.target.value }))}
                    rows={6}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-whatsapp-500 focus:border-whatsapp-500"
                    placeholder="Digite o conteúdo da mensagem..."
                    required
                  />
                </div>

                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="isActive"
                    checked={newQuickMessage.isActive}
                    onChange={(e) => setNewQuickMessage(prev => ({ ...prev, isActive: e.target.checked }))}
                    className="h-4 w-4 text-whatsapp-600 focus:ring-whatsapp-500 border-gray-300 rounded"
                  />
                  <label htmlFor="isActive" className="ml-2 block text-sm text-gray-900">
                    Mensagem ativa
                  </label>
                </div>

                <div className="flex space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowCreateQuickMessage(false)}
                    className="flex-1 px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-whatsapp-500"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={createQuickMessageMutation.isPending}
                    className="flex-1 px-4 py-2 bg-whatsapp-600 text-white rounded-md hover:bg-whatsapp-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-whatsapp-500 disabled:opacity-50"
                  >
                    {createQuickMessageMutation.isPending ? (
                      <div className="flex items-center justify-center">
                        <i className="fas fa-spinner fa-spin mr-2"></i>
                        Criando...
                      </div>
                    ) : (
                      "Criar Mensagem"
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Edit Quick Message Modal */}
      {editingMessage && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900">Editar Mensagem Rápida</h3>
                <button
                  onClick={() => setEditingMessage(null)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <i className="fas fa-times"></i>
                </button>
              </div>

              <form onSubmit={handleUpdateQuickMessage} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Título
                  </label>
                  <input
                    type="text"
                    value={editingMessage.title}
                    onChange={(e) => setEditingMessage(prev => ({ ...prev, title: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-whatsapp-500 focus:border-whatsapp-500"
                    placeholder="Ex: Boas vindas, Informações de entrega..."
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Tipo da Mensagem
                  </label>
                  <select
                    value={editingMessage.messageType}
                    onChange={(e) => setEditingMessage(prev => ({ ...prev, messageType: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-whatsapp-500 focus:border-whatsapp-500"
                  >
                    <option value="text">Texto Simples</option>
                    <option value="product_menu">Cardápio de Produtos</option>
                    <option value="order_form">Formulário de Pedido</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Conteúdo
                  </label>
                  <textarea
                    value={editingMessage.content}
                    onChange={(e) => setEditingMessage(prev => ({ ...prev, content: e.target.value }))}
                    rows={6}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-whatsapp-500 focus:border-whatsapp-500"
                    placeholder="Digite o conteúdo da mensagem..."
                    required
                  />
                </div>

                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="editIsActive"
                    checked={editingMessage.isActive}
                    onChange={(e) => setEditingMessage(prev => ({ ...prev, isActive: e.target.checked }))}
                    className="h-4 w-4 text-whatsapp-600 focus:ring-whatsapp-500 border-gray-300 rounded"
                  />
                  <label htmlFor="editIsActive" className="ml-2 block text-sm text-gray-900">
                    Mensagem ativa
                  </label>
                </div>

                <div className="flex space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={() => setEditingMessage(null)}
                    className="flex-1 px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-whatsapp-500"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={updateQuickMessageMutation.isPending}
                    className="flex-1 px-4 py-2 bg-whatsapp-600 text-white rounded-md hover:bg-whatsapp-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-whatsapp-500 disabled:opacity-50"
                  >
                    {updateQuickMessageMutation.isPending ? (
                      <div className="flex items-center justify-center">
                        <i className="fas fa-spinner fa-spin mr-2"></i>
                        Salvando...
                      </div>
                    ) : (
                      "Salvar Alterações"
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

