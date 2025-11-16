import { useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { ConversationList } from "@/components/conversation-list";
import { ChatArea } from "@/components/chat-area";
import { AgentPanel } from "@/components/agent-panel";
import { WhatsAppSimulator } from "@/components/whatsapp-simulator";
import { SettingsModal } from "@/components/settings-modal";
import { CustomerSearchModal } from "@/components/customer-search-modal";
import { QuickMessages } from "@/components/quick-messages";
import { useWebSocket } from "@/hooks/use-websocket";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ConversationWithCustomer, Customer } from "@shared/schema";
import logoImage from "@/assets/logo.jpg";

interface DashboardProps {
  user: {
    id: string;
    username: string;
    email: string;
    role: 'admin' | 'agent' | 'delivery';
  };
  onLogout: () => void;
  onNavigateToAdmin?: () => void;
  onNavigateToWhatsAppSetup?: () => void;
  onNavigateToTelegramSetup?: () => void;
}

export default function Dashboard({ user, onLogout, onNavigateToAdmin, onNavigateToWhatsAppSetup, onNavigateToTelegramSetup }: DashboardProps) {
  const [selectedConversation, setSelectedConversation] = useState<ConversationWithCustomer | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCustomerSearchOpen, setIsCustomerSearchOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<'conversations' | 'chat' | 'quick-messages'>('conversations');
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  // Connect to WebSocket for real-time updates
  useWebSocket();

  const { data: stats } = useQuery({
    queryKey: ["/api/stats"],
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  const { data: conversations } = useQuery({
    queryKey: ["/api/conversations"],
    refetchInterval: 5000, // Refresh every 5 seconds
  });

  const { data: agents } = useQuery({
    queryKey: ["/api/agents"],
    refetchInterval: 10000, // Refresh every 10 seconds
  });

  // Transfer conversation mutation (admin only)
  const transferConversationMutation = useMutation({
    mutationFn: async ({ conversationId, targetAgentId }: { conversationId: string, targetAgentId: string }) => {
      return apiRequest("POST", `/api/conversations/${conversationId}/transfer`, { targetAgentId });
    },
    onSuccess: () => {
      toast({
        title: "Sucesso",
        description: "Conversa transferida com sucesso",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao transferir conversa",
        variant: "destructive",
      });
    },
  });

  // Pull conversation mutation (admin only)
  const pullConversationMutation = useMutation({
    mutationFn: async (conversationId: string) => {
      return apiRequest("POST", `/api/conversations/${conversationId}/pull`, {});
    },
    onSuccess: () => {
      toast({
        title: "Sucesso",
        description: "Conversa assumida com sucesso",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao assumir conversa",
        variant: "destructive",
      });
    },
  });

  // Create new conversation mutation
  const createConversationMutation = useMutation({
    mutationFn: async (customer: Customer) => {
      const response = await apiRequest("POST", "/api/conversations/start", { 
        customerId: customer.id,
        customerPhone: customer.phone,
        customerName: customer.name 
      });
      return await response.json();
    },
    onSuccess: (newConversation: ConversationWithCustomer) => {
      toast({
        title: "Sucesso",
        description: "Nova conversa iniciada com sucesso",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      // Select the new conversation and switch to chat
      setSelectedConversation(newConversation);
      if (window.innerWidth < 768) {
        setActivePanel('chat');
      }
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao iniciar conversa",
        variant: "destructive",
      });
    },
  });

  // Handle conversation selection for mobile
  const handleConversationSelect = (conversation: ConversationWithCustomer) => {
    setSelectedConversation(conversation);
    if (window.innerWidth < 768) {
      setActivePanel('chat');
    }
  };

  // Handle mobile navigation
  const handleMobileNavigation = (panel: 'conversations' | 'chat' | 'quick-messages') => {
    setActivePanel(panel);
    setIsMobileMenuOpen(false);
  };

  // Handle conversation transfer (admin only)
  const handleTransferConversation = (conversationId: string, targetAgentId: string) => {
    if (user.role !== "admin") {
      toast({
        title: "Erro",
        description: "Apenas administradores podem transferir conversas",
        variant: "destructive",
      });
      return;
    }
    transferConversationMutation.mutate({ conversationId, targetAgentId });
  };

  // Handle conversation pull (admin only)
  const handlePullConversation = (conversationId: string) => {
    if (user.role !== "admin") {
      toast({
        title: "Erro", 
        description: "Apenas administradores podem assumir conversas",
        variant: "destructive",
      });
      return;
    }
    pullConversationMutation.mutate(conversationId);
  };

  // Handle customer selection for new conversation
  const handleCustomerSelect = (customer: Customer) => {
    createConversationMutation.mutate(customer);
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-gray-50 md:flex-row">
      {/* Mobile Header */}
      <div className="md:hidden bg-whatsapp-500 text-white">
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center space-x-3">
            <img 
              src={logoImage} 
              alt="Sistema Logo" 
              className="w-8 h-8 rounded-full object-cover"
            />
            <div>
              <h1 className="font-semibold text-lg">WhatsApp Business</h1>
              <p className="text-whatsapp-100 text-xs">{user.username}</p>
            </div>
          </div>
          <button
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="p-2 rounded-md hover:bg-whatsapp-600 transition-colors"
          >
            <i className={`fas ${isMobileMenuOpen ? 'fa-times' : 'fa-bars'}`}></i>
          </button>
        </div>
        
        {/* Mobile Navigation Menu */}
        {isMobileMenuOpen && (
          <div className="border-t border-whatsapp-400 bg-whatsapp-600">
            <div className="p-4 space-y-2">
              {user.role === 'admin' && onNavigateToAdmin && (
                <button
                  onClick={onNavigateToAdmin}
                  className="w-full text-left p-2 rounded-md hover:bg-whatsapp-700 transition-colors"
                >
                  <i className="fas fa-cog mr-2"></i>
                  Painel Admin
                </button>
              )}
              {onNavigateToWhatsAppSetup && (
                <button
                  onClick={onNavigateToWhatsAppSetup}
                  className="w-full text-left p-2 rounded-md hover:bg-whatsapp-700 transition-colors"
                >
                  <i className="fab fa-whatsapp mr-2"></i>
                  Config WhatsApp
                </button>
              )}
              {onNavigateToTelegramSetup && (
                <button
                  onClick={onNavigateToTelegramSetup}
                  className="w-full text-left p-2 rounded-md hover:bg-whatsapp-700 transition-colors"
                >
                  <i className="fab fa-telegram mr-2"></i>
                  Config Telegram
                </button>
              )}
              {user.role === 'admin' && (
                <button
                  onClick={() => setIsSettingsOpen(true)}
                  className="w-full text-left p-2 rounded-md hover:bg-whatsapp-700 transition-colors"
                >
                  <i className="fas fa-cog mr-2"></i>
                  Configurações
                </button>
              )}
              <button
                onClick={onLogout}
                className="w-full text-left p-2 rounded-md hover:bg-whatsapp-700 transition-colors"
              >
                <i className="fas fa-sign-out-alt mr-2"></i>
                Sair
              </button>
            </div>
          </div>
        )}
        
        {/* Mobile Bottom Navigation */}
        <div className="flex border-t border-whatsapp-400">
          <button
            onClick={() => handleMobileNavigation('conversations')}
            className={`flex-1 py-3 px-4 text-center ${
              activePanel === 'conversations' ? 'bg-whatsapp-700' : 'hover:bg-whatsapp-600'
            }`}
          >
            <i className="fas fa-comments block mb-1"></i>
            <span className="text-xs">Conversas</span>
          </button>
          <button
            onClick={() => handleMobileNavigation('chat')}
            className={`flex-1 py-3 px-4 text-center ${
              activePanel === 'chat' ? 'bg-whatsapp-700' : 'hover:bg-whatsapp-600'
            }`}
            disabled={!selectedConversation}
          >
            <i className="fas fa-comment-dots block mb-1"></i>
            <span className="text-xs">Chat</span>
          </button>
          <button
            onClick={() => handleMobileNavigation('quick-messages')}
            className={`flex-1 py-3 px-4 text-center ${
              activePanel === 'quick-messages' ? 'bg-whatsapp-700' : 'hover:bg-whatsapp-600'
            }`}
          >
            <i className="fas fa-bolt block mb-1"></i>
            <span className="text-xs">Rápidas</span>
          </button>
        </div>
      </div>

      {/* Desktop Sidebar / Mobile Panel - Conversations */}
      <div className={`${
        activePanel === 'conversations' ? 'flex' : 'hidden'
      } md:flex md:w-64 bg-white border-r border-gray-200 flex-col flex-1 md:h-screen overflow-hidden`}>
        {/* Desktop Header - Hidden on mobile */}
        <div className="hidden md:block p-4 border-b border-gray-200 bg-whatsapp-500">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 flex items-center justify-center">
                <img 
                  src={logoImage} 
                  alt="Sistema Logo" 
                  className="w-10 h-10 rounded-full object-cover shadow-md"
                />
              </div>
              <div>
                <h1 className="text-white font-semibold text-lg">WhatsApp Business</h1>
                <p className="text-whatsapp-100 text-sm">Central de Atendimento</p>
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <div className="text-white text-right mr-3">
                <p className="text-sm font-medium">{user.username}</p>
                <p className="text-xs text-whatsapp-100">{user.role === 'admin' ? 'Administrador' : 'Agente'}</p>
              </div>
              {onNavigateToAdmin && (
                <button
                  onClick={onNavigateToAdmin}
                  className="text-white hover:text-whatsapp-100 transition-colors mr-2"
                  title="Painel Administrativo"
                >
                  <i className="fas fa-cogs text-lg"></i>
                </button>
              )}
              {onNavigateToWhatsAppSetup && (
                <button
                  onClick={onNavigateToWhatsAppSetup}
                  className="text-white hover:text-whatsapp-100 transition-colors mr-2"
                  title="Configurar WhatsApp"
                >
                  <i className="fab fa-whatsapp text-lg"></i>
                </button>
              )}
              {user.role === 'admin' && (
                <button
                  onClick={() => setIsSettingsOpen(true)}
                  className="text-white hover:text-whatsapp-100 transition-colors mr-2"
                  title="Configurações"
                >
                  <i className="fas fa-cog text-lg"></i>
                </button>
              )}
              <button
                onClick={onLogout}
                className="text-white hover:text-whatsapp-100 transition-colors"
                title="Sair"
              >
                <i className="fas fa-sign-out-alt text-lg"></i>
              </button>
            </div>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-blue-50 p-3 rounded-lg">
              <div className="text-blue-600 text-sm font-medium">Aguardando</div>
              <div className="text-blue-900 text-xl font-bold">{(stats as any)?.waiting || 0}</div>
            </div>
            <div className="bg-green-50 p-3 rounded-lg">
              <div className="text-green-600 text-sm font-medium">Em Atendimento</div>
              <div className="text-green-900 text-xl font-bold">{(stats as any)?.inProgress || 0}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-yellow-50 p-3 rounded-lg">
              <div className="text-yellow-600 text-sm font-medium">Resolvidas Hoje</div>
              <div className="text-yellow-900 text-xl font-bold">{(stats as any)?.resolved || 0}</div>
            </div>
            <div className="bg-purple-50 p-3 rounded-lg">
              <div className="text-purple-600 text-sm font-medium">Agentes Online</div>
              <div className="text-purple-900 text-xl font-bold">{(stats as any)?.agentsOnline || 0}</div>
            </div>
          </div>
        </div>

        {/* New Conversation Button */}
        <div className="p-4">
          <button
            onClick={() => setIsCustomerSearchOpen(true)}
            className="w-full bg-whatsapp-500 hover:bg-whatsapp-600 text-white font-medium py-3 px-4 rounded-lg transition-colors flex items-center justify-center space-x-2"
            data-testid="button-new-conversation"
          >
            <i className="fas fa-plus"></i>
            <span>Iniciar Nova Conversa</span>
          </button>
        </div>

        <ConversationList 
          conversations={(conversations as ConversationWithCustomer[]) || []}
          selectedConversation={selectedConversation}
          onSelectConversation={handleConversationSelect}
          currentUser={user}
          agents={(agents as any[]) || []}
          onTransferConversation={handleTransferConversation}
          onPullConversation={handlePullConversation}
        />
      </div>

      {/* Chat Area Panel - Mobile/Desktop */}
      <div className={`${
        activePanel === 'chat' ? 'flex' : 'hidden'
      } md:flex flex-1 flex-col bg-white md:bg-gray-50 md:h-screen overflow-hidden`}>
        {/* Mobile Back Button */}
        <div className="md:hidden bg-whatsapp-500 text-white p-4 flex items-center space-x-3">
          <button
            onClick={() => setActivePanel('conversations')}
            className="p-1 hover:bg-whatsapp-600 rounded"
          >
            <i className="fas fa-arrow-left"></i>
          </button>
          {selectedConversation && (
            <div className="flex items-center space-x-3 flex-1">
              <div className="w-8 h-8 bg-whatsapp-300 rounded-full flex items-center justify-center">
                <i className="fas fa-user text-whatsapp-700 text-sm"></i>
              </div>
              <div>
                <h3 className="font-medium text-sm">{selectedConversation.customer.name || selectedConversation.customer.phone}</h3>
                <p className="text-xs text-whatsapp-100">
                  {selectedConversation.status === 'waiting' ? 'Aguardando' : 
                   selectedConversation.status === 'in_progress' ? 'Em atendimento' : 'Resolvida'}
                </p>
              </div>
            </div>
          )}
        </div>

        {selectedConversation ? (
          <ChatArea conversation={selectedConversation} currentUser={user} />
        ) : (
          <div className="flex-1 flex items-center justify-center bg-gray-50">
            <div className="text-center p-8">
              <div className="w-16 h-16 md:w-24 md:h-24 bg-gray-200 rounded-full flex items-center justify-center mx-auto mb-4">
                <i className="fab fa-whatsapp text-gray-400 text-2xl md:text-4xl"></i>
              </div>
              <h2 className="text-lg md:text-xl font-semibold text-gray-700 mb-2">WhatsApp Business</h2>
              <p className="text-sm md:text-base text-gray-500">Selecione uma conversa para começar</p>
            </div>
          </div>
        )}
      </div>

      {/* Quick Messages Panel - Mobile/Desktop */}
      <div className={`${
        activePanel === 'quick-messages' ? 'flex' : 'hidden'
      } md:flex md:w-64 bg-white border-l border-gray-200 flex-col flex-1 md:h-screen overflow-hidden`}>
        {/* Mobile Back Button for Quick Messages */}
        <div className="md:hidden bg-whatsapp-500 text-white p-4 flex items-center space-x-3">
          <button
            onClick={() => setActivePanel('conversations')}
            className="p-1 hover:bg-whatsapp-600 rounded"
          >
            <i className="fas fa-arrow-left"></i>
          </button>
          <h3 className="font-medium">Mensagens Rápidas</h3>
        </div>

        <div className="flex-1 overflow-hidden">
          <QuickMessages 
            selectedConversationId={selectedConversation?.id}
            onMessageSent={() => {
              // Refresh conversation data when message is sent
              queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
              // On mobile, go back to chat after sending message
              if (window.innerWidth < 768 && selectedConversation) {
                setActivePanel('chat');
              }
            }}
          />
        </div>
        
        {/* Agent panel - Desktop only */}
        {selectedConversation && (
          <div className="hidden md:block border-t border-gray-200">
            <AgentPanel 
              conversation={selectedConversation}
              agents={(agents as any) || []}
            />
          </div>
        )}
      </div>

      {/* WhatsApp Simulator */}
      <WhatsAppSimulator />

      {/* Settings Modal */}
      <SettingsModal 
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />

      {/* Customer Search Modal */}
      <CustomerSearchModal 
        isOpen={isCustomerSearchOpen}
        onClose={() => setIsCustomerSearchOpen(false)}
        onSelectCustomer={handleCustomerSelect}
      />
    </div>
  );
}
