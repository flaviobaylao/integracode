import { useState } from "react";
import type { ChatConversationWithCustomer } from "@shared/schema";

interface ConversationListProps {
  conversations: ChatConversationWithCustomer[];
  selectedConversation: ChatConversationWithCustomer | null;
  onSelectConversation: (conversation: ChatConversationWithCustomer) => void;
  currentUser?: any;
  agents?: any[];
  onTransferConversation?: (conversationId: string, targetAgentId: string) => void;
  onPullConversation?: (conversationId: string) => void;
}

export function ConversationList({ 
  conversations, 
  selectedConversation, 
  onSelectConversation,
  currentUser,
  agents = [],
  onTransferConversation,
  onPullConversation
}: ConversationListProps) {
  const [filter, setFilter] = useState<"all" | "new" | "urgent">("all");

  const filteredConversations = conversations.filter(conversation => {
    switch (filter) {
      case "new":
        return conversation.status === "new";
      case "urgent":
        return conversation.priority === "urgent";
      default:
        return true;
    }
  });

  const getStatusColor = (status: string, priority: string) => {
    if (priority === "urgent") return "border-red-400 bg-red-50";
    switch (status) {
      case "new":
        return "border-orange-400 bg-orange-50";
      case "assigned":
      case "in-progress":
        return "border-blue-400 bg-blue-50";
      case "resolved":
        return "border-green-400 bg-green-50";
      default:
        return "border-gray-400 bg-gray-50";
    }
  };

  const getStatusText = (status: string, priority: string) => {
    if (priority === "urgent") return { text: "Urgente", color: "bg-red-100 text-red-800" };
    switch (status) {
      case "new":
        return { text: "Nova", color: "bg-orange-100 text-orange-800" };
      case "assigned":
        return { text: "Atribuída", color: "bg-blue-100 text-blue-800" };
      case "in-progress":
        return { text: "Em Andamento", color: "bg-blue-100 text-blue-800" };
      case "resolved":
        return { text: "Resolvida", color: "bg-green-100 text-green-800" };
      default:
        return { text: "Desconhecido", color: "bg-gray-100 text-gray-800" };
    }
  };

  const formatTime = (date: Date | null) => {
    if (!date) return "";
    return new Date(date).toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <>
      {/* Filters */}
      <div className="px-4 pb-3">
        <div className="flex space-x-2">
          <button 
            onClick={() => setFilter("all")}
            className={`flex-1 px-3 py-2 text-sm rounded-lg font-medium transition-colors ${
              filter === "all" 
                ? "bg-whatsapp-500 text-white" 
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            Todas
          </button>
          <button 
            onClick={() => setFilter("new")}
            className={`flex-1 px-3 py-2 text-sm rounded-lg font-medium transition-colors ${
              filter === "new" 
                ? "bg-whatsapp-500 text-white" 
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            Novas
          </button>
          <button 
            onClick={() => setFilter("urgent")}
            className={`flex-1 px-3 py-2 text-sm rounded-lg font-medium transition-colors ${
              filter === "urgent" 
                ? "bg-whatsapp-500 text-white" 
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            Urgentes
          </button>
        </div>
      </div>

      {/* Conversation List */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-2">
          {filteredConversations.map((conversation) => {
            const statusInfo = getStatusText(conversation.status, conversation.priority);
            const isSelected = selectedConversation?.id === conversation.id;
            
            return (
              <div
                key={conversation.id}
                onClick={() => onSelectConversation(conversation)}
                className={`p-3 rounded-lg cursor-pointer border-l-4 mb-2 transition-colors ${
                  getStatusColor(conversation.status, conversation.priority)
                } ${isSelected ? "ring-2 ring-whatsapp-500" : "hover:bg-opacity-75"}`}
              >
                <div className="flex items-start space-x-3">
                  <div className="w-10 h-10 bg-gray-300 rounded-full flex items-center justify-center flex-shrink-0">
                    <i className="fas fa-user text-gray-600"></i>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium text-gray-900 truncate">
                        {conversation.customer.name}
                      </span>
                      <span className="text-xs text-gray-500">
                        {formatTime(conversation.lastMessageTime)}
                      </span>
                    </div>
                    <p className="text-sm text-gray-600 truncate">
                      {conversation.lastMessage?.content || "Nova conversa"}
                    </p>
                    <div className="flex items-center justify-between mt-2">
                      <span className={`px-2 py-1 text-xs rounded-full ${statusInfo.color}`}>
                        {statusInfo.text}
                      </span>
                      <div className="flex items-center space-x-1">
                        <div className={`w-2 h-2 rounded-full ${
                          conversation.priority === "urgent" 
                            ? "bg-red-400 animate-pulse" 
                            : conversation.agentId 
                              ? "bg-green-400" 
                              : "bg-orange-400"
                        }`}></div>
                        <span className="text-xs text-gray-500">
                          {conversation.agent?.name || "Aguardando"}
                        </span>
                      </div>
                    </div>
                    
                    {/* Admin Actions */}
                    {currentUser?.role === "admin" && (
                      <div className="flex space-x-1 mt-2">
                        {/* Transfer Button */}
                        <div className="relative group">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (onTransferConversation) {
                                const targetAgent = prompt(`Transferir para (ID do agente):\n\nAgentes disponíveis:\n${agents.map(a => `${a.id}: ${a.name}`).join('\n')}`);
                                if (targetAgent) {
                                  onTransferConversation(conversation.id, targetAgent);
                                }
                              }
                            }}
                            className="px-2 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
                            data-testid={`button-transfer-${conversation.id}`}
                          >
                            <i className="fas fa-exchange-alt mr-1"></i>
                            Transferir
                          </button>
                        </div>
                        
                        {/* Pull Button */}
                        {conversation.agentId !== currentUser.agentId && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (onPullConversation) {
                                onPullConversation(conversation.id);
                              }
                            }}
                            className="px-2 py-1 text-xs bg-green-500 text-white rounded hover:bg-green-600 transition-colors"
                            data-testid={`button-pull-${conversation.id}`}
                          >
                            <i className="fas fa-arrow-down mr-1"></i>
                            Puxar
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          
          {filteredConversations.length === 0 && (
            <div className="text-center py-8">
              <i className="fas fa-comments text-gray-300 text-4xl mb-2"></i>
              <p className="text-gray-500">Nenhuma conversa encontrada</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
