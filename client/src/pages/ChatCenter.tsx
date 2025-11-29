import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { queryClient } from "@/lib/queryClient";
import { Send, Clock, AlertCircle, CheckCircle, Phone, Plus, Paperclip, Image as ImageIcon, Music, File, User, MapPin } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useToast } from "@/hooks/use-toast";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { useAuth } from "@/hooks/useAuth";

interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderType: "customer" | "agent" | "system";
  content: string;
  messageType: string;
  createdAt: Date | string;
  isRead: boolean;
}

interface Conversation {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  agentId?: string;
  agentName?: string;
  status: "new" | "assigned" | "in-progress" | "resolved";
  priority: "normal" | "urgent";
  lastMessageTime: string;
  messageCount: number;
  unreadCount?: number; // 🟢 Número de mensagens não lidas
  hasUnread?: boolean; // 🟢 Flag para mostrar indicador
  messages?: ChatMessage[];
}

interface Agent {
  id: string;
  name: string;
  status: string;
}

export default function ChatCenter() {
  const { toast } = useToast();
  const [location] = useLocation();
  const { user } = useAuth();
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [messageText, setMessageText] = useState("");
  const [assignedAgent, setAssignedAgent] = useState<string>("");
  const [showNewConversation, setShowNewConversation] = useState(false);
  const [newPhoneNumber, setNewPhoneNumber] = useState("");
  const [newCustomerName, setNewCustomerName] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [mediaCaption, setMediaCaption] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 🎯 Selecionar conversa automaticamente se vindo de um botão WhatsApp
  useEffect(() => {
    try {
      const params = new URLSearchParams(location.split('?')[1]);
      const conversationId = params.get('conversationId');
      if (conversationId) {
        console.log('🎯 [ChatCenter] Abrindo conversa:', conversationId);
        setSelectedConversation(conversationId);
        // Remover o parâmetro da URL para limpar
        window.history.replaceState({}, '', '/telemarketing/atendimento');
      }
    } catch (error) {
      console.warn('⚠️ [ChatCenter] Erro ao ler parâmetro:', error);
    }
  }, [location]);

  // Fetch conversations - CORREÇÃO: polling cada 500ms para real-time melhor
  const { data: conversationsData, isLoading: convLoading, refetch: refetchConversations } = useQuery({
    queryKey: ["/api/chat/conversations"],
    refetchInterval: 500  // 🚀 Reduzido de 2000ms para 500ms para updates mais rápidos
  });
  const conversations = (conversationsData as Conversation[]) || [];

  // Fetch messages para a conversa selecionada - CORREÇÃO: polling cada 300ms
  const { data: messagesData, isLoading: messagesLoading, refetch: refetchMessages } = useQuery({
    queryKey: ["/api/chat/conversations", selectedConversation, "messages"],
    enabled: !!selectedConversation,
    refetchInterval: 300,  // 🚀 Polling rápido para atualizar mensagens em tempo real
    queryFn: async () => {
      const response = await fetch(`/api/chat/conversations/${selectedConversation}/messages`);
      if (!response.ok) throw new Error("Falha ao buscar mensagens");
      return response.json();
    }
  });
  const messagesRaw = (messagesData as ChatMessage[]) || [];
  
  // 📍 Ordenar mensagens: não lidas primeiro, depois por data
  const messages = [...messagesRaw].sort((a, b) => {
    // Não lidas vêm primeiro
    if (!a.isRead && b.isRead) return -1;
    if (a.isRead && !b.isRead) return 1;
    // Se ambas têm o mesmo status de leitura, ordenar por data
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  // Fetch agents
  const { data: agentsData } = useQuery({
    queryKey: ["/api/chat/agents"],
  });
  const agents = (agentsData as Agent[]) || [];

  // Fetch quick templates
  const { data: templatesData } = useQuery({
    queryKey: ["/api/chat/quick-templates"],
  });
  const templates = (templatesData as any[]) || [];

  // Fetch agent detailed stats (admin only)
  const isAdmin = user?.role === 'admin' || user?.role === 'coordinator' || user?.role === 'administrative';
  const { data: agentStatsData } = useQuery({
    queryKey: ["/api/chat/agents/detailed-stats"],
    enabled: isAdmin,
    refetchInterval: 5000,
  });
  const agentStats = (agentStatsData as any[]) || [];

  // Seller info will be fetched later after selectedChat is determined

  // Mutation para fazer upload de arquivo
  const uploadFileMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return fetch("/api/chat/upload", {
        method: "POST",
        body: formData
      }).then(r => r.json());
    },
    onSuccess: (data) => {
      toast({ title: "Sucesso", description: "Arquivo enviado com sucesso" });
    },
    onError: () => {
      toast({ title: "Erro", description: "Falha ao fazer upload do arquivo", variant: "destructive" });
    }
  });

  // Mutation para enviar mensagem
  const sendMessageMutation = useMutation({
    mutationFn: async (content: string) => {
      if (!selectedConversation) throw new Error("Nenhuma conversa selecionada");
      return fetch(`/api/chat/conversations/${selectedConversation}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          senderType: "agent",
          messageType: "text"
        })
      }).then(r => r.json());
    },
    onSuccess: () => {
      setMessageText("");
      // Invalidar tanto mensagens quanto conversas para recarregar agentId
      queryClient.invalidateQueries({ queryKey: ["/api/chat/conversations", selectedConversation, "messages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/conversations"] });
    },
    onError: () => {
      toast({ title: "Erro", description: "Não foi possível enviar a mensagem", variant: "destructive" });
    }
  });

  // Mutation para enviar mídia
  const sendMediaMutation = useMutation({
    mutationFn: async ({ mediaUrl, messageType }: { mediaUrl: string; messageType: string }) => {
      if (!selectedConversation) throw new Error("Nenhuma conversa selecionada");
      return fetch(`/api/chat/conversations/${selectedConversation}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: mediaCaption || "",
          mediaUrl,
          messageType,
          senderType: "agent"
        })
      }).then(r => r.json());
    },
    onSuccess: () => {
      setMediaCaption("");
      setSelectedFile(null);
      queryClient.invalidateQueries({ queryKey: ["/api/chat/conversations", selectedConversation, "messages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/conversations"] });
      toast({ title: "Sucesso", description: "Mídia enviada com sucesso" });
    },
    onError: () => {
      toast({ title: "Erro", description: "Falha ao enviar mídia", variant: "destructive" });
    }
  });

  // Mutation para enviar localização
  const sendLocationMutation = useMutation({
    mutationFn: async () => {
      if (!selectedConversation) throw new Error("Nenhuma conversa selecionada");
      return new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          async (position) => {
            try {
              const response = await fetch(`/api/chat/conversations/${selectedConversation}/message`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  content: "Localização compartilhada",
                  latitude: position.coords.latitude,
                  longitude: position.coords.longitude,
                  messageType: "location",
                  senderType: "agent"
                })
              });
              resolve(response.json());
            } catch (error) {
              reject(error);
            }
          },
          (error) => reject(error)
        );
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/chat/conversations", selectedConversation, "messages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/conversations"] });
      toast({ title: "Sucesso", description: "Localização enviada com sucesso" });
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error?.message || "Falha ao obter localização", variant: "destructive" });
    }
  });

  // Mutation para atribuir conversa
  const assignConversationMutation = useMutation({
    mutationFn: async (agentId: string) => {
      if (!selectedConversation) throw new Error("Nenhuma conversa selecionada");
      return fetch(`/api/chat/conversations/${selectedConversation}/assign`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId })
      }).then(r => r.json());
    },
    onSuccess: () => {
      toast({ title: "Sucesso", description: "Conversa atribuída com sucesso" });
      queryClient.invalidateQueries({ queryKey: ["/api/chat/conversations"] });
    }
  });

  // Mutation para atualizar status
  const updateStatusMutation = useMutation({
    mutationFn: async (status: string) => {
      if (!selectedConversation) throw new Error("Nenhuma conversa selecionada");
      return fetch(`/api/chat/conversations/${selectedConversation}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
      }).then(r => r.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/chat/conversations"] });
    }
  });

  // Mutation para iniciar nova conversa
  const startConversationMutation = useMutation({
    mutationFn: async ({ phoneNumber, customerName }: { phoneNumber: string; customerName: string }) => {
      return fetch(`/api/chat/conversations/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          customerPhone: phoneNumber.replace(/\D/g, ''),
          customerName: customerName || `Cliente ${phoneNumber}`
        })
      }).then(r => r.json());
    },
    onSuccess: (data) => {
      toast({ title: "Sucesso", description: "Conversa iniciada com sucesso" });
      setShowNewConversation(false);
      setNewPhoneNumber("");
      setNewCustomerName("");
      queryClient.invalidateQueries({ queryKey: ["/api/chat/conversations"] });
      if (data.id) setSelectedConversation(data.id);
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error.message || "Erro ao iniciar conversa", variant: "destructive" });
    }
  });

  const selectedChat = conversations.find((c: Conversation) => c.id === selectedConversation);

  // Fetch seller info for customer (after selectedChat is defined)
  const { data: sellerInfoData } = useQuery({
    queryKey: ["/api/chat/customer-seller", selectedChat?.customerPhone],
    enabled: !!selectedChat?.customerPhone,
    queryFn: async () => {
      const response = await fetch(`/api/chat/customer-seller/${selectedChat?.customerPhone}`);
      if (!response.ok) throw new Error("Falha ao buscar vendedor");
      return response.json();
    }
  });
  const sellerName = (sellerInfoData as any)?.sellerName || "Carregando...";

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSendMessage = async () => {
    if (!messageText.trim()) return;
    await sendMessageMutation.mutateAsync(messageText);
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setSelectedFile(file);
  };

  const getMediaType = (file: File): 'image' | 'audio' | 'video' | 'document' => {
    const mime = file.type;
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';
    return 'document';
  };

  const handleSendMedia = async () => {
    if (!selectedFile) return;
    
    try {
      const uploadResult = await uploadFileMutation.mutateAsync(selectedFile);
      if (uploadResult.success && uploadResult.file?.url) {
        const mediaType = getMediaType(selectedFile);
        await sendMediaMutation.mutateAsync({
          mediaUrl: uploadResult.file.url,
          messageType: mediaType
        });
      }
    } catch (error) {
      console.error('Erro ao enviar mídia:', error);
    }
  };

  const getStatusColor = (status: string) => {
    const colors: Record<string, string> = {
      "new": "bg-blue-100 text-blue-700",
      "assigned": "bg-purple-100 text-purple-700",
      "in-progress": "bg-yellow-100 text-yellow-700",
      "resolved": "bg-green-100 text-green-700",
    };
    return colors[status] || "bg-gray-100 text-gray-700";
  };

  const getPriorityIcon = (priority: string) => {
    return priority === "urgent" ? "🔴" : "⚪";
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-orange-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 mb-2">Central de Atendimento WhatsApp</h1>
            <p className="text-gray-600">Gerencie conversas e atenda clientes em tempo real</p>
          </div>
          <BackToDashboardButton />
        </div>

        <div className={`grid grid-cols-1 ${isAdmin ? "lg:grid-cols-5" : "lg:grid-cols-4"} gap-6`}>
          {isAdmin && (
            // Sidebar esquerda com stats de agentes
            <div className="lg:col-span-1">
              <Card className="h-full">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Atendentes</CardTitle>
                  <CardDescription>Status e performance</CardDescription>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[600px] pr-4">
                    {agentStats.length === 0 ? (
                      <div className="text-center py-8 text-gray-500 text-xs">Carregando...</div>
                    ) : (
                      agentStats.map((agent: any) => (
                        <div key={agent.id} className="border rounded-lg p-2 mb-2 bg-gray-50 hover:bg-gray-100 transition">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`inline-block w-2 h-2 rounded-full ${agent.status === 'online' ? 'bg-green-500' : 'bg-gray-400'}`}></span>
                            <p className="text-xs font-semibold truncate flex-1">{agent.name}</p>
                          </div>
                          <div className="text-xs text-gray-600 space-y-0.5 ml-3">
                            <p>✅ Respondidas: <span className="font-semibold">{agent.messagesAnswered}</span></p>
                            <p>📥 A responder: <span className="font-semibold text-red-600">{agent.messagesToRespond}</span></p>
                          </div>
                        </div>
                      ))
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>
          )}
          
          {/* Lista de Conversas */}
          <div className="lg:col-span-1">
            <Card className="h-full">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-lg">Conversas</CardTitle>
                    <CardDescription>{conversations.length} conversas</CardDescription>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => setShowNewConversation(true)}
                    className="bg-green-600 hover:bg-green-700"
                    data-testid="button-new-conversation"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-96">
                  <div className="space-y-2">
                    {convLoading ? (
                      <div className="text-center py-4 text-gray-500">Carregando...</div>
                    ) : conversations.length === 0 ? (
                      <div className="text-center py-4 text-gray-500">Nenhuma conversa</div>
                    ) : (
                      conversations.map((conv) => (
                        <button
                          key={conv.id}
                          onClick={() => setSelectedConversation(conv.id)}
                          className={`w-full text-left p-3 rounded-lg transition-colors ${
                            selectedConversation === conv.id
                              ? "bg-green-100 border-2 border-green-600"
                              : "bg-gray-50 hover:bg-gray-100 border border-gray-200"
                          }`}
                          data-testid={`button-conversation-${conv.id}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="font-semibold text-sm text-gray-900 truncate">
                                  {conv.customerName}
                                </p>
                                {/* 🟢 Indicador verde com número de mensagens não lidas */}
                                {conv.hasUnread && conv.unreadCount! > 0 && (
                                  <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-green-500 text-white text-xs font-bold flex-shrink-0">
                                    {conv.unreadCount}
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-gray-500">{conv.customerPhone}</p>
                              <p className="text-xs text-gray-600 truncate mt-1">{conv.lastMessageTime}</p>
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="text-xs">{getPriorityIcon(conv.priority)}</span>
                              <Badge variant="outline" className="text-xs">{conv.messageCount}</Badge>
                            </div>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </div>

          {/* Chat */}
          <div className="lg:col-span-3 space-y-4">
            {selectedChat ? (
              <>
                {/* Info do Cliente */}
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <CardTitle className="text-lg">{selectedChat.customerName}</CardTitle>
                        <div className="flex items-center gap-2 mt-2">
                          <Phone className="w-4 h-4 text-gray-600" />
                          <span className="text-sm text-gray-600">{selectedChat.customerPhone}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-2 text-xs text-blue-600">
                          <User className="w-3 h-3" />
                          <span>Vendedor: <strong>{sellerName}</strong></span>
                        </div>
                        {selectedChat.agentId && (
                          <div className="flex items-center gap-2 mt-2 text-xs text-green-600 font-semibold">
                            <span>👤 Atendente: {agents.find(a => a.id === selectedChat.agentId)?.name || "Carregando..."}</span>
                          </div>
                        )}
                      </div>
                      <Badge className={getStatusColor(selectedChat.status)}>
                        {selectedChat.status === "new" ? "Novo" : 
                         selectedChat.status === "assigned" ? "Atribuído" :
                         selectedChat.status === "in-progress" ? "Em andamento" : "Resolvido"}
                      </Badge>
                    </div>
                  </CardHeader>
                </Card>

                {/* Área de Chat */}
                <Card className="flex flex-col h-96">
                  <CardContent className="flex-1 overflow-hidden p-4">
                    <ScrollArea ref={scrollRef} className="h-full">
                      <div className="space-y-4">
                        {messagesLoading ? (
                          <div className="text-center py-8 text-gray-500">Carregando mensagens...</div>
                        ) : messages.length === 0 ? (
                          <div className="text-center py-8 text-gray-500">Nenhuma mensagem ainda</div>
                        ) : (
                          messages.map((msg: any) => (
                            <div
                              key={msg.id}
                              className={`flex ${msg.senderType === "agent" ? "justify-end" : "justify-start"} ${!msg.isRead ? "mb-3 p-2 bg-blue-50 rounded border-l-4 border-blue-500" : ""}`}
                              data-testid={`message-${msg.id}`}
                            >
                              <div className="flex gap-2 items-flex-end">
                                <div
                                  className={`max-w-xs px-4 py-2 rounded-lg ${
                                    msg.senderType === "agent"
                                      ? "bg-green-600 text-white"
                                      : !msg.isRead
                                      ? "bg-blue-200 text-gray-900 font-semibold border-2 border-blue-400"
                                      : "bg-gray-200 text-gray-900"
                                  }`}
                                >
                                  {!msg.isRead && msg.senderType !== "agent" && (
                                    <div className="flex items-center gap-2 mb-2">
                                      <span className="inline-block h-2 w-2 bg-blue-600 rounded-full animate-pulse"></span>
                                      <span className="text-xs font-bold text-blue-700">NÃO LIDA</span>
                                    </div>
                                  )}
                                {msg.senderType !== "agent" && (
                                  <div className="text-xs font-semibold mb-1 opacity-80">
                                    👤 {sellerName}
                                  </div>
                                )}
                                {msg.messageType === 'location' && msg.content.includes('[Localização:') ? (
                                  <div className="mb-2 bg-gradient-to-r from-green-100 to-blue-100 p-2 rounded">
                                    <p className="text-xs font-semibold flex items-center gap-1">📍 {msg.content}</p>
                                  </div>
                                ) : msg.mediaUrl ? (
                                  <div className="mb-2">
                                    {msg.messageType === 'image' && <img src={msg.mediaUrl} alt="mídia" className="max-w-sm rounded" />}
                                    {msg.messageType === 'audio' && <audio src={msg.mediaUrl} controls className="max-w-sm" />}
                                    {msg.messageType === 'video' && <video src={msg.mediaUrl} controls className="max-w-sm rounded" />}
                                    {msg.messageType === 'document' && <a href={msg.mediaUrl} target="_blank" rel="noopener noreferrer" className="underline">📄 {msg.content || 'Documento'}</a>}
                                  </div>
                                ) : null}
                                {msg.messageType !== 'location' && <p className="text-sm">{msg.content}</p>}
                                  <p className={`text-xs mt-1 ${msg.senderType === "agent" ? "opacity-70" : "opacity-75"}`}>
                                    {msg.createdAt ? format(new Date(msg.createdAt), "HH:mm", { locale: ptBR }) : ""}
                                  </p>
                                </div>
                                {!msg.isRead && msg.senderType !== "agent" && (
                                  <Badge className="bg-green-500 text-white text-xs whitespace-nowrap mb-2" data-testid={`badge-unread-${msg.id}`}>
                                    🟢 Não Lida
                                  </Badge>
                                )}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </ScrollArea>
                  </CardContent>
                </Card>

                {/* Controles */}
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm">Atribuição e Status</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-sm font-medium text-gray-700">Atribua a um agente</label>
                        <Select value={selectedChat.agentId || ""} onValueChange={setAssignedAgent}>
                          <SelectTrigger data-testid="select-agent">
                            <SelectValue placeholder="Selecione..." />
                          </SelectTrigger>
                          <SelectContent>
                            {agents.map((agent) => (
                              <SelectItem key={agent.id} value={agent.id}>
                                {agent.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <label className="text-sm font-medium text-gray-700">Status</label>
                        <Select value={selectedChat.status} onValueChange={(status) => updateStatusMutation.mutate(status)}>
                          <SelectTrigger data-testid="select-status">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="new">Novo</SelectItem>
                            <SelectItem value="assigned">Atribuído</SelectItem>
                            <SelectItem value="in-progress">Em andamento</SelectItem>
                            <SelectItem value="resolved">Resolvido</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    {assignedAgent && (
                      <Button 
                        onClick={() => assignConversationMutation.mutate(assignedAgent)}
                        disabled={assignConversationMutation.isPending}
                        data-testid="button-assign"
                        className="w-full"
                      >
                        Atribuir Conversa
                      </Button>
                    )}
                  </CardContent>
                </Card>

                {/* Input de Mensagem com Templates */}
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm">Escrever Mensagem</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {templates.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {templates.slice(0, 4).map((template: any) => (
                          <Button
                            key={template.id}
                            variant="outline"
                            size="sm"
                            onClick={() => setMessageText(template.content)}
                            data-testid={`button-template-${template.id}`}
                            className="text-xs"
                          >
                            {template.title}
                          </Button>
                        ))}
                      </div>
                    )}
                    {selectedFile && (
                      <div className="bg-blue-50 p-3 rounded flex items-center justify-between">
                        <span className="text-sm text-gray-700">📎 {selectedFile.name}</span>
                        <button onClick={() => setSelectedFile(null)} className="text-red-500 text-sm">✕</button>
                      </div>
                    )}
                    {selectedFile && (
                      <Input
                        placeholder="Adicione uma legenda (opcional)..."
                        value={mediaCaption}
                        onChange={(e) => setMediaCaption(e.target.value)}
                        data-testid="input-media-caption"
                      />
                    )}
                    <div className="flex gap-2">
                      <Textarea
                        placeholder="Digite sua mensagem (Ctrl+Enter para enviar)..."
                        value={messageText}
                        onChange={(e) => setMessageText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && e.ctrlKey) {
                            handleSendMessage();
                          }
                        }}
                        data-testid="textarea-message"
                        className="resize-none"
                        rows={3}
                        disabled={!!selectedFile}
                      />
                      <div className="flex flex-col gap-2 self-end">
                        {!selectedFile ? (
                          <>
                            <input
                              ref={fileInputRef}
                              type="file"
                              onChange={handleFileSelect}
                              accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.xls,.xlsx"
                              className="hidden"
                              data-testid="input-file"
                            />
                            <Button
                              onClick={() => fileInputRef.current?.click()}
                              variant="outline"
                              size="icon"
                              data-testid="button-upload"
                              title="Enviar mídia"
                            >
                              <Paperclip className="w-4 h-4" />
                            </Button>
                            <Button
                              onClick={() => sendLocationMutation.mutate()}
                              variant="outline"
                              size="icon"
                              disabled={sendLocationMutation.isPending}
                              data-testid="button-location"
                              title="Enviar localização"
                            >
                              <MapPin className="w-4 h-4" />
                            </Button>
                          </>
                        ) : (
                          <Button
                            onClick={handleSendMedia}
                            disabled={sendMediaMutation.isPending || uploadFileMutation.isPending}
                            data-testid="button-send-media"
                            className="bg-blue-600"
                          >
                            {uploadFileMutation.isPending ? "Enviando..." : <Send className="w-4 h-4" />}
                          </Button>
                        )}
                        {!selectedFile && (
                          <Button
                            onClick={handleSendMessage}
                            disabled={!messageText.trim() || sendMessageMutation.isPending}
                            data-testid="button-send"
                          >
                            <Send className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </>
            ) : (
              <Card className="h-full flex items-center justify-center">
                <div className="text-center">
                  <AlertCircle className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                  <p className="text-gray-600">Selecione uma conversa para começar</p>
                </div>
              </Card>
            )}
          </div>
        </div>

        {/* Dialog para iniciar nova conversa */}
        <Dialog open={showNewConversation} onOpenChange={setShowNewConversation}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Iniciar Nova Conversa</DialogTitle>
              <DialogDescription>Insira o número telefônico e o nome do cliente para iniciar uma nova conversa</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Número Telefônico</label>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-600 px-3 py-2 bg-gray-100 rounded">+55</span>
                  <Input
                    placeholder="62 9 9578-2812"
                    value={newPhoneNumber}
                    onChange={(e) => setNewPhoneNumber(e.target.value.replace(/\D/g, ''))}
                    maxLength={11}
                    data-testid="input-phone-number"
                  />
                </div>
                <p className="text-xs text-gray-500 mt-1">DDD (2 dígitos) + Telefone (8-9 dígitos)</p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Nome do Cliente (opcional)</label>
                <Input
                  placeholder="Ex: João Silva"
                  value={newCustomerName}
                  onChange={(e) => setNewCustomerName(e.target.value)}
                  data-testid="input-customer-name"
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowNewConversation(false);
                    setNewPhoneNumber("");
                    setNewCustomerName("");
                  }}
                >
                  Cancelar
                </Button>
                <Button
                  onClick={() => {
                    if (!newPhoneNumber.length || newPhoneNumber.length < 10) {
                      toast({ title: "Erro", description: "Insira um DDD válido (2 dígitos) e telefone (8-9 dígitos)", variant: "destructive" });
                      return;
                    }
                    startConversationMutation.mutate({ 
                      phoneNumber: `+55${newPhoneNumber}`, 
                      customerName: newCustomerName 
                    });
                  }}
                  disabled={startConversationMutation.isPending || newPhoneNumber.length < 10}
                  className="bg-green-600 hover:bg-green-700"
                  data-testid="button-start-conversation"
                >
                  {startConversationMutation.isPending ? "Iniciando..." : "Iniciar"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
