import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { queryClient } from "@/lib/queryClient";
import { Send, Clock, AlertCircle, CheckCircle, Phone, Plus } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useToast } from "@/hooks/use-toast";
import BackToDashboardButton from "@/components/BackToDashboardButton";

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
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [messageText, setMessageText] = useState("");
  const [assignedAgent, setAssignedAgent] = useState<string>("");
  const [showNewConversation, setShowNewConversation] = useState(false);
  const [newPhoneNumber, setNewPhoneNumber] = useState("");
  const [newCustomerName, setNewCustomerName] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

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
  const messages = (messagesData as ChatMessage[]) || [];

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
      queryClient.invalidateQueries({ queryKey: ["/api/chat/conversations", selectedConversation, "messages"] });
    },
    onError: () => {
      toast({ title: "Erro", description: "Não foi possível enviar a mensagem", variant: "destructive" });
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

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSendMessage = async () => {
    if (!messageText.trim()) return;
    await sendMessageMutation.mutateAsync(messageText);
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

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
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
                          messages.map((msg) => (
                            <div
                              key={msg.id}
                              className={`flex ${msg.senderType === "agent" ? "justify-end" : "justify-start"}`}
                              data-testid={`message-${msg.id}`}
                            >
                              <div
                                className={`max-w-xs px-4 py-2 rounded-lg ${
                                  msg.senderType === "agent"
                                    ? "bg-green-600 text-white"
                                    : "bg-gray-200 text-gray-900"
                                }`}
                              >
                                <p className="text-sm">{msg.content}</p>
                                <p className="text-xs opacity-70 mt-1">
                                  {msg.createdAt ? format(new Date(msg.createdAt), "HH:mm", { locale: ptBR }) : ""}
                                </p>
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
                      />
                      <Button
                        onClick={handleSendMessage}
                        disabled={!messageText.trim() || sendMessageMutation.isPending}
                        data-testid="button-send"
                        className="self-end"
                      >
                        <Send className="w-4 h-4" />
                      </Button>
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
