import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";
import { MessageInput } from "@/components/chat/message-input";
import { TransferConversationModal } from "@/components/chat/transfer-conversation-modal";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import type { ChatConversationWithCustomer, ChatMessageWithSender } from "@shared/schema";

function getMediaUrl(url: string | null | undefined): string {
  if (!url) return '';
  if (url.startsWith('data:')) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/objects/') || url.startsWith('/uploads/') || url.startsWith('/api/')) {
    return `${window.location.origin}${url}`;
  }
  return url;
}

interface QuickMessage {
  id: string;
  title: string;
  content: string;
  messageType: string;
  isActive: boolean;
}

interface ChatAreaProps {
  conversation: ChatConversationWithCustomer;
  currentUser?: {
    id: string;
    username: string;
    email: string;
    role: 'admin' | 'agent' | 'delivery';
  };
}

export function ChatArea({ conversation, currentUser }: ChatAreaProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [thankYouMessage, setThankYouMessage] = useState("Obrigado pelo contato! Ficamos à disposição para qualquer dúvida.");
  const [isFinishDialogOpen, setIsFinishDialogOpen] = useState(false);
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const { toast } = useToast();
  
  // Get agent ID from current user
  const { data: agents } = useQuery<Array<{ id: string; userId: string }>>({
    queryKey: ["/api/agents"],
    enabled: !!currentUser,
  });
  const agentId = agents?.find(a => a.userId === currentUser?.id)?.id || "";

  const { data: conversationData, isLoading } = useQuery<{ messages: ChatMessageWithSender[] }>({
    queryKey: ["/api/conversations", conversation.id],
    refetchInterval: 2000, // Refresh every 2 seconds for new messages
  });

  const messages: ChatMessageWithSender[] = conversationData?.messages || [];

  // Auto-sync conversation history mutation
  const syncHistoryMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", `/api/conversations/${conversation.id}/sync-history`, {});
    },
    onSuccess: (data: any) => {
      if (data.messageCount > 0) {
        console.log(`✅ ${data.messageCount} mensagens históricas sincronizadas`);
        queryClient.invalidateQueries({ queryKey: ["/api/conversations", conversation.id] });
      }
    },
    onError: (error: any) => {
      // Silently handle errors - Evolution API might not be configured
      console.log('Auto-sync não disponível:', error);
    },
  });

  // Auto-sync history when conversation is opened and has no messages
  // Wait for initial query to finish to avoid redundant sync requests
  useEffect(() => {
    if (!isLoading && conversationData && messages.length === 0 && !syncHistoryMutation.isPending) {
      syncHistoryMutation.mutate();
    }
  }, [conversation.id, isLoading, conversationData]); // Only run when conversation or loading state changes

  // Fetch quick messages for the message input
  const { data: quickMessages } = useQuery<QuickMessage[]>({
    queryKey: ["/api/quick-messages/active"],
  });

  const assignConversationMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", `/api/conversations/${conversation.id}/assign`, {
        agentId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", conversation.id] });
    },
  });

  const resolveConversationMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("PATCH", `/api/conversations/${conversation.id}`, {
        status: "resolved",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", conversation.id] });
    },
  });

  const transferToHumanMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", `/api/conversations/${conversation.id}/transfer-to-human`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", conversation.id] });
    },
  });

  const finishConversationMutation = useMutation({
    mutationFn: async (thankYouMessage: string) => {
      return apiRequest("POST", `/api/conversations/${conversation.id}/finish`, {
        thankYouMessage,
      });
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", conversation.id] });
      setIsFinishDialogOpen(false);
      
      // Mostrar métricas do atendimento
      if (data?.metrics) {
        const { waitingTime, responseTime } = data.metrics;
        toast({
          title: "Atendimento finalizado com sucesso!",
          description: `Tempo de espera: ${Math.floor((waitingTime || 0) / 60)}min ${(waitingTime || 0) % 60}s | Tempo total: ${Math.floor((responseTime || 0) / 60)}min ${(responseTime || 0) % 60}s`,
          duration: 5000,
        });
      } else {
        toast({
          title: "Atendimento finalizado!",
          description: "Mensagem de agradecimento enviada ao cliente.",
        });
      }
    },
    onError: () => {
      toast({
        title: "Erro ao finalizar atendimento",
        description: "Tente novamente em alguns instantes.",
        variant: "destructive",
      });
    },
  });

  const reopenConversationMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", `/api/conversations/${conversation.id}/reopen`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", conversation.id] });
      toast({
        title: "Conversa reaberta!",
        description: "Você pode continuar atendendo o cliente.",
      });
    },
    onError: () => {
      toast({
        title: "Erro ao reabrir conversa",
        description: "Tente novamente em alguns instantes.",
        variant: "destructive",
      });
    },
  });

  const handleFinishConversation = () => {
    finishConversationMutation.mutate(thankYouMessage);
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const formatMessageTime = (date: Date) => {
    return new Date(date).toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const canAssign = !conversation.agentId || conversation.status === "new";
  const canResolve = conversation.agentId && conversation.status !== "resolved";
  const isBotConversation = conversation.agent?.type === "bot";
  const canTransferToHuman = isBotConversation && conversation.status !== "resolved";
  const canTransferToAgent = conversation.agentId && conversation.status !== "resolved" && conversation.agent?.type === "human";
  const canReopen = conversation.status === "resolved";

  return (
    <>
      {/* Chat Header - Hidden on mobile since mobile has its own header */}
      <div className="hidden md:block bg-white border-b border-gray-200 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <div className="w-12 h-12 bg-gray-300 rounded-full flex items-center justify-center">
              <i className="fas fa-user text-gray-600 text-lg"></i>
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h2 className="font-semibold text-lg">{conversation.customer.name}</h2>
                {isBotConversation && (
                  <span className="px-2 py-1 text-xs bg-blue-100 text-blue-600 rounded-full">
                    <i className="fas fa-robot mr-1"></i>
                    ChatGPT
                  </span>
                )}
              </div>
              <div className="flex items-center space-x-2">
                <span className="text-sm text-gray-500">{conversation.customer.phone}</span>
                <span className="w-1 h-1 bg-gray-400 rounded-full"></span>
                <span className="text-sm text-green-600">Online</span>
              </div>
            </div>
          </div>
          <div className="flex items-center space-x-3">
            {canReopen && (
              <button
                onClick={() => reopenConversationMutation.mutate()}
                disabled={reopenConversationMutation.isPending}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors flex items-center space-x-2 disabled:opacity-50"
                data-testid="button-reopen-conversation"
              >
                <i className="fas fa-redo"></i>
                <span>Reabrir Conversa</span>
              </button>
            )}
            {canTransferToHuman && (
              <button
                onClick={() => transferToHumanMutation.mutate()}
                disabled={transferToHumanMutation.isPending}
                className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors flex items-center space-x-2 disabled:opacity-50"
              >
                <i className="fas fa-user-friends"></i>
                <span className="hidden lg:inline">Transferir p/ Humano</span>
                <span className="lg:hidden">Transferir</span>
              </button>
            )}
            {canTransferToAgent && (
              <button
                onClick={() => setIsTransferModalOpen(true)}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors flex items-center space-x-2"
                data-testid="button-transfer-agent"
              >
                <i className="fas fa-exchange-alt"></i>
                <span className="hidden lg:inline">Transferir Agente</span>
                <span className="lg:hidden">Transferir</span>
              </button>
            )}
            {canAssign && (
              <button
                onClick={() => assignConversationMutation.mutate()}
                disabled={assignConversationMutation.isPending}
                className="px-4 py-2 bg-whatsapp-500 text-white rounded-lg hover:bg-whatsapp-600 transition-colors flex items-center space-x-2 disabled:opacity-50"
              >
                <i className="fas fa-user-check"></i>
                <span>Assumir</span>
              </button>
            )}
            {canResolve && (
              <Dialog open={isFinishDialogOpen} onOpenChange={setIsFinishDialogOpen}>
                <DialogTrigger asChild>
                  <button
                    className="px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 transition-colors flex items-center space-x-2"
                    data-testid="button-finish-conversation"
                  >
                    <i className="fas fa-check-double"></i>
                    <span>Finalizar Atendimento</span>
                  </button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>Finalizar Atendimento</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="thankYouMessage">Mensagem de agradecimento (opcional)</Label>
                      <Textarea
                        id="thankYouMessage"
                        placeholder="Digite uma mensagem de agradecimento para o cliente..."
                        value={thankYouMessage}
                        onChange={(e) => setThankYouMessage(e.target.value)}
                        className="mt-2"
                        rows={3}
                      />
                    </div>
                    <div className="flex justify-end space-x-2">
                      <Button
                        variant="outline"
                        onClick={() => setIsFinishDialogOpen(false)}
                      >
                        Cancelar
                      </Button>
                      <Button
                        onClick={handleFinishConversation}
                        disabled={finishConversationMutation.isPending}
                        className="bg-green-500 hover:bg-green-600"
                        data-testid="button-confirm-finish"
                      >
                        {finishConversationMutation.isPending ? (
                          <>
                            <i className="fas fa-spinner fa-spin mr-2"></i>
                            Finalizando...
                          </>
                        ) : (
                          <>
                            <i className="fas fa-check mr-2"></i>
                            Finalizar
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            )}
          </div>
        </div>
      </div>

      {/* Mobile Action Bar */}
      <div className="md:hidden bg-gray-50 border-b border-gray-200 p-3">
        <div className="flex justify-center space-x-3">
          {canReopen && (
            <button
              onClick={() => reopenConversationMutation.mutate()}
              disabled={reopenConversationMutation.isPending}
              className="flex-1 max-w-32 px-3 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors flex items-center justify-center space-x-2 disabled:opacity-50 text-sm"
              data-testid="button-reopen-conversation-mobile"
            >
              <i className="fas fa-redo"></i>
              <span>Reabrir</span>
            </button>
          )}
          {canTransferToHuman && (
            <button
              onClick={() => transferToHumanMutation.mutate()}
              disabled={transferToHumanMutation.isPending}
              className="flex-1 max-w-32 px-3 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors flex items-center justify-center space-x-2 disabled:opacity-50 text-sm"
            >
              <i className="fas fa-user-friends"></i>
              <span>Transferir</span>
            </button>
          )}
          {canTransferToAgent && (
            <button
              onClick={() => setIsTransferModalOpen(true)}
              className="flex-1 max-w-32 px-3 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors flex items-center justify-center space-x-2 text-sm"
              data-testid="button-transfer-agent-mobile"
            >
              <i className="fas fa-exchange-alt"></i>
              <span>Transferir</span>
            </button>
          )}
          {canAssign && (
            <button
              onClick={() => assignConversationMutation.mutate()}
              disabled={assignConversationMutation.isPending}
              className="flex-1 max-w-32 px-3 py-2 bg-whatsapp-500 text-white rounded-lg hover:bg-whatsapp-600 transition-colors flex items-center justify-center space-x-2 disabled:opacity-50 text-sm"
            >
              <i className="fas fa-user-check"></i>
              <span>Assumir</span>
            </button>
          )}
          {canResolve && (
            <Dialog open={isFinishDialogOpen} onOpenChange={setIsFinishDialogOpen}>
              <DialogTrigger asChild>
                <button
                  className="flex-1 max-w-32 px-3 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 transition-colors flex items-center justify-center space-x-2 text-sm"
                >
                  <i className="fas fa-check-double"></i>
                  <span>Finalizar</span>
                </button>
              </DialogTrigger>
            </Dialog>
          )}
        </div>
      </div>

      {/* Chat Messages - Responsive */}
      <div 
        className="flex-1 overflow-y-auto p-3 md:p-4 space-y-3 md:space-y-4"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='60' viewBox='0 0 60 60'%3E%3Cg fill-rule='evenodd'%3E%3Cg fill='%23f8f9fa' fill-opacity='0.1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`
        }}
      >
        {messages.map((message) => {
          const isCustomer = message.senderType === "customer";
          const isSystem = message.senderType === "system";

          if (isSystem) {
            return (
              <div key={message.id} className="flex justify-center">
                <div className="bg-yellow-100 text-yellow-800 px-3 md:px-4 py-2 rounded-full text-xs md:text-sm max-w-xs md:max-w-md">
                  <i className="fas fa-info-circle mr-1"></i>
                  {message.content}
                </div>
              </div>
            );
          }

          return (
            <div key={message.id} className={`flex ${isCustomer ? "justify-start" : "justify-end"}`}>
              <div className="max-w-[85%] sm:max-w-xs lg:max-w-md">
                <div className={`rounded-lg shadow-sm p-3 ${
                  isCustomer 
                    ? "bg-white rounded-bl-none" 
                    : "bg-whatsapp-500 rounded-br-none"
                }`}>
                  {/* Media Content */}
                  {message.messageType === 'image' && message.mediaUrl && (
                    <div className="mb-2">
                      <img 
                        src={getMediaUrl(message.mediaUrl)} 
                        alt={message.mediaFilename || 'Imagem'} 
                        className="rounded-lg max-w-full h-auto cursor-pointer"
                        onError={(e) => {
                          const target = e.currentTarget;
                          target.style.display = 'none';
                          const fallback = target.nextElementSibling as HTMLElement;
                          if (fallback) fallback.style.display = 'flex';
                        }}
                        onClick={() => window.open(getMediaUrl(message.mediaUrl), '_blank')}
                      />
                      <div className="hidden items-center justify-center p-4 bg-gray-100 rounded-lg text-gray-500 text-sm">
                        <i className="fas fa-image mr-2"></i>
                        Imagem não disponível
                      </div>
                    </div>
                  )}
                  {message.messageType === 'audio' && message.mediaUrl && (
                    <div className="mb-2">
                      <audio controls className="w-full">
                        <source src={getMediaUrl(message.mediaUrl)} type={message.mediaType || 'audio/mpeg'} />
                        Seu navegador não suporta áudio.
                      </audio>
                    </div>
                  )}
                  {message.messageType === 'video' && message.mediaUrl && (
                    <div className="mb-2">
                      <video controls className="rounded-lg max-w-full h-auto">
                        <source src={getMediaUrl(message.mediaUrl)} type={message.mediaType || 'video/mp4'} />
                        Seu navegador não suporta vídeo.
                      </video>
                    </div>
                  )}
                  {message.messageType === 'document' && message.mediaUrl && (
                    <div className="mb-2 flex items-center space-x-2 p-2 bg-gray-100 rounded">
                      <i className="fas fa-file text-2xl text-gray-600"></i>
                      <div className="flex-1">
                        <p className="text-sm font-medium text-gray-800">{message.mediaFilename || 'Documento'}</p>
                        <p className="text-xs text-gray-600">
                          {message.mediaSize ? `${(message.mediaSize / 1024).toFixed(1)} KB` : ''}
                        </p>
                      </div>
                      <a 
                        href={getMediaUrl(message.mediaUrl)} 
                        download 
                        className="text-whatsapp-500 hover:text-whatsapp-600"
                      >
                        <i className="fas fa-download"></i>
                      </a>
                    </div>
                  )}
                  {message.messageType === 'location' && message.latitude && message.longitude && (
                    <div className="mb-2">
                      <div className="bg-gray-100 p-2 rounded flex items-start space-x-2">
                        <i className="fas fa-map-marker-alt text-red-500 text-xl"></i>
                        <div className="flex-1">
                          <p className="text-sm font-medium text-gray-800">Localização</p>
                          <a 
                            href={`https://www.google.com/maps?q=${message.latitude},${message.longitude}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-600 hover:underline"
                          >
                            Ver no Google Maps
                          </a>
                        </div>
                      </div>
                    </div>
                  )}
                  
                  {/* Text Content */}
                  {message.content && (
                    <p className={`text-sm md:text-base break-words ${isCustomer ? "text-gray-800" : "text-white"}`}>
                      {message.content}
                    </p>
                  )}
                  
                  <div className="flex items-center justify-end space-x-1 mt-2">
                    <span className={`text-xs ${
                      isCustomer ? "text-gray-500" : "text-whatsapp-100"
                    }`}>
                      {message.timestamp ? formatMessageTime(message.timestamp) : ''}
                    </span>
                    {!isCustomer && (
                      <i className="fas fa-check-double text-whatsapp-100 text-xs"></i>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Message Input */}
      <MessageInput 
        conversationId={conversation.id}
        disabled={conversation.status === "resolved"}
        quickMessages={quickMessages || []}
        agentId={agentId}
      />

      {/* Transfer Conversation Modal */}
      <TransferConversationModal
        isOpen={isTransferModalOpen}
        onClose={() => setIsTransferModalOpen(false)}
        conversationId={conversation.id}
        currentAgentId={conversation.agentId || ""}
      />
    </>
  );
}
