import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";

interface QuickMessage {
  id: string;
  title: string;
  content: string;
  messageType: string;
  isActive: boolean;
  createdAt: string;
}

interface QuickMessagesProps {
  selectedConversationId?: string;
  onMessageSent?: () => void;
}

export function QuickMessages({ selectedConversationId, onMessageSent }: QuickMessagesProps) {
  const [expandedMessage, setExpandedMessage] = useState<string | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: quickMessages, isLoading } = useQuery({
    queryKey: ["/api/quick-messages/active"],
  });

  const sendMessageMutation = useMutation({
    mutationFn: async ({ conversationId, content }: { conversationId: string; content: string }) => {
      return apiRequest(`/api/conversations/${conversationId}/messages`, "POST", {
        content,
        sender: "agent",
        messageType: "text",
      });
    },
    onSuccess: () => {
      toast({
        title: "Mensagem enviada",
        description: "Mensagem rápida enviada com sucesso!",
      });
      // Invalidate conversation messages to refresh the chat
      if (selectedConversationId) {
        queryClient.invalidateQueries({
          queryKey: ["/api/conversations", selectedConversationId, "messages"],
        });
      }
      onMessageSent?.();
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao enviar mensagem",
        variant: "destructive",
      });
    },
  });

  const handleSendMessage = (content: string) => {
    if (!selectedConversationId) {
      toast({
        title: "Aviso",
        description: "Selecione uma conversa para enviar a mensagem",
        variant: "destructive",
      });
      return;
    }

    sendMessageMutation.mutate({ conversationId: selectedConversationId, content });
  };

  const getMessageIcon = (messageType: string) => {
    switch (messageType) {
      case "product_menu":
        return "🧃";
      case "order_form":
        return "📋";
      case "text":
      default:
        return "💬";
    }
  };

  const getMessageTypeLabel = (messageType: string) => {
    switch (messageType) {
      case "product_menu":
        return "Cardápio";
      case "order_form":
        return "Pedido";
      case "text":
      default:
        return "Texto";
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <i className="fas fa-comment-dots mr-2 text-blue-600"></i>
            Mensagens Rápidas
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base md:text-lg">
          <div className="flex items-center">
            <i className="fas fa-comment-dots mr-2 text-blue-600 text-sm md:text-base"></i>
            <span className="hidden sm:inline">Mensagens Rápidas</span>
            <span className="sm:hidden">Rápidas</span>
          </div>
          <Badge variant="secondary" className="text-xs">
            {(quickMessages as QuickMessage[])?.length || 0}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-0">
        <ScrollArea className="h-[calc(100vh-16rem)] md:h-[400px] pr-2 md:pr-4">
          <div className="space-y-2 md:space-y-3">
            {(quickMessages as QuickMessage[])?.map((message: QuickMessage) => (
              <div key={message.id} className="border rounded-lg p-2 md:p-3 hover:bg-gray-50 transition-colors">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-start space-x-2 flex-1 min-w-0">
                    <span className="text-sm md:text-lg mt-0.5">{getMessageIcon(message.messageType)}</span>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-medium text-xs md:text-sm truncate">{message.title}</h4>
                      <Badge variant="outline" className="text-xs mt-1 md:hidden">
                        {getMessageTypeLabel(message.messageType)}
                      </Badge>
                    </div>
                  </div>
                  <div className="flex items-center space-x-1 md:space-x-2 flex-shrink-0">
                    <Badge variant="outline" className="text-xs hidden md:inline-flex">
                      {getMessageTypeLabel(message.messageType)}
                    </Badge>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setExpandedMessage(
                        expandedMessage === message.id ? null : message.id
                      )}
                      className="text-xs px-1 md:px-2 py-1 h-6 md:h-8"
                    >
                      {expandedMessage === message.id ? (
                        <i className="fas fa-eye-slash text-xs"></i>
                      ) : (
                        <i className="fas fa-eye text-xs"></i>
                      )}
                    </Button>
                  </div>
                </div>

                {expandedMessage === message.id && (
                  <div className="mt-2 md:mt-3 space-y-2 md:space-y-3">
                    <Textarea
                      value={message.content}
                      readOnly
                      className="text-xs md:text-sm resize-none"
                      rows={Math.min(message.content.split('\n').length + 1, 6)}
                    />
                    <Button
                      onClick={() => handleSendMessage(message.content)}
                      disabled={!selectedConversationId || sendMessageMutation.isPending}
                      className="w-full"
                      size="sm"
                    >
                      {sendMessageMutation.isPending ? (
                        <>
                          <div className="animate-spin rounded-full h-3 w-3 md:h-4 md:w-4 border-b-2 border-white mr-1 md:mr-2"></div>
                          <span className="text-xs md:text-sm">Enviando...</span>
                        </>
                      ) : (
                        <>
                          <i className="fas fa-paper-plane mr-1 md:mr-2 text-xs md:text-sm"></i>
                          <span className="text-xs md:text-sm">Enviar</span>
                        </>
                      )}
                    </Button>
                  </div>
                )}

                {expandedMessage !== message.id && (
                  <p className="text-xs text-gray-600 mt-1 line-clamp-2">
                    {message.content.length > 80 
                      ? `${message.content.substring(0, 80)}...` 
                      : message.content}
                  </p>
                )}
              </div>
            ))}

            {(!quickMessages || (quickMessages as QuickMessage[]).length === 0) && (
              <div className="text-center py-8 text-gray-500">
                <i className="fas fa-comment-slash text-3xl mb-2"></i>
                <p>Nenhuma mensagem rápida disponível</p>
              </div>
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}