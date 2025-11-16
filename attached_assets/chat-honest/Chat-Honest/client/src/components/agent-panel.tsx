import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConversationWithCustomer, Agent } from "@shared/schema";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { EditIcon, CheckIcon, XIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface AgentPanelProps {
  conversation: ConversationWithCustomer;
  agents: Agent[];
}

export function AgentPanel({ conversation, agents }: AgentPanelProps) {
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState(conversation.customer.name);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Mutation to update customer name
  const updateCustomerMutation = useMutation({
    mutationFn: async (nameData: { name: string }) => {
      const response = await apiRequest("PUT", `/api/customers/${conversation.customer.id}`, nameData);
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Sucesso",
        description: "Nome do cliente atualizado com sucesso",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      setIsEditingName(false);
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao atualizar nome do cliente",
        variant: "destructive",
      });
      setEditedName(conversation.customer.name); // Reset to original name
    },
  });

  const handleStartEdit = () => {
    setIsEditingName(true);
    setEditedName(conversation.customer.name);
  };

  const handleSaveEdit = () => {
    if (!editedName.trim()) {
      toast({
        title: "Erro",
        description: "Nome não pode estar vazio",
        variant: "destructive",
      });
      return;
    }

    if (editedName.trim() !== conversation.customer.name) {
      updateCustomerMutation.mutate({ name: editedName.trim() });
    } else {
      setIsEditingName(false);
    }
  };

  const handleCancelEdit = () => {
    setIsEditingName(false);
    setEditedName(conversation.customer.name);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "online":
        return "bg-green-400";
      case "busy":
        return "bg-yellow-400";
      case "offline":
        return "bg-gray-400";
      default:
        return "bg-gray-400";
    }
  };

  const formatLastContact = (date: Date) => {
    const now = new Date();
    const lastContact = new Date(date);
    const diffInHours = Math.floor((now.getTime() - lastContact.getTime()) / (1000 * 60 * 60));
    
    if (diffInHours < 1) return "Agora";
    if (diffInHours < 24) return `${diffInHours}h atrás`;
    return lastContact.toLocaleDateString("pt-BR");
  };

  return (
    <div className="w-64 bg-white border-l border-gray-200 overflow-y-auto">
      {/* Customer Info */}
      <div className="p-4 border-b border-gray-200 group">
        <h3 className="font-semibold text-lg mb-3">Informações do Cliente</h3>
        <div className="space-y-3">
          <div className="flex items-center justify-center">
            <div className="w-20 h-20 bg-gray-300 rounded-full flex items-center justify-center">
              <i className="fas fa-user text-gray-600 text-2xl"></i>
            </div>
          </div>
          <div className="text-center">
            {isEditingName ? (
              <div className="flex items-center space-x-2 justify-center">
                <Input
                  type="text"
                  value={editedName}
                  onChange={(e) => setEditedName(e.target.value)}
                  className="h-8 text-center text-sm font-medium"
                  data-testid="input-edit-customer-name"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleSaveEdit();
                    } else if (e.key === 'Escape') {
                      handleCancelEdit();
                    }
                  }}
                />
                <div className="flex space-x-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleSaveEdit}
                    disabled={updateCustomerMutation.isPending}
                    className="h-6 w-6 p-0"
                    data-testid="button-save-customer-name"
                  >
                    <CheckIcon className="h-3 w-3 text-green-600" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleCancelEdit}
                    className="h-6 w-6 p-0"
                    data-testid="button-cancel-edit-name"
                  >
                    <XIcon className="h-3 w-3 text-red-600" />
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center space-x-2">
                <h4 className="font-medium text-gray-900" data-testid="text-customer-name">{conversation.customer.name}</h4>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleStartEdit}
                  className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  data-testid="button-edit-customer-name"
                >
                  <EditIcon className="h-3 w-3 text-gray-500" />
                </Button>
              </div>
            )}
            <p className="text-sm text-gray-500" data-testid="text-customer-phone">{conversation.customer.phone}</p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-gray-500">Conversas:</span>
              <span className="font-medium text-gray-900 ml-1">
                {conversation.customer.totalConversations}
              </span>
            </div>
            <div>
              <span className="text-gray-500">Última:</span>
              <span className="font-medium text-gray-900 ml-1">
                {formatLastContact(conversation.customer.lastContact)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Agents Online */}
      <div className="p-4 border-b border-gray-200">
        <h3 className="font-semibold text-lg mb-3">Agentes Online</h3>
        <div className="space-y-2">
          {agents.map((agent) => (
            <div key={agent.id} className="flex items-center space-x-3 p-2 rounded-lg hover:bg-gray-50">
              <div className="relative">
                <div className="w-8 h-8 bg-gray-300 rounded-full flex items-center justify-center">
                  <i className="fas fa-user text-gray-600 text-sm"></i>
                </div>
                <div className={`absolute -bottom-1 -right-1 w-3 h-3 border-2 border-white rounded-full ${getStatusColor(agent.status)}`}></div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center space-x-2">
                  <p className="font-medium text-sm text-gray-900 truncate">{agent.name}</p>
                  {agent.type === "bot" && (
                    <span className="px-2 py-1 text-xs bg-blue-100 text-blue-600 rounded-full">
                      <i className="fas fa-robot mr-1"></i>
                      Bot
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500">
                  {agent.status === "offline" 
                    ? "Offline" 
                    : agent.status === "busy" 
                      ? "Ocupado" 
                      : agent.type === "bot"
                        ? "Atendimento automático"
                        : `${agent.activeConversations} conversas ativas`
                  }
                </p>
              </div>
            </div>
          ))}
          
          {agents.length === 0 && (
            <div className="text-center py-4">
              <i className="fas fa-user-slash text-gray-300 text-2xl mb-2"></i>
              <p className="text-gray-500 text-sm">Nenhum agente online</p>
            </div>
          )}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="p-4">
        <h3 className="font-semibold text-lg mb-3">Ações Rápidas</h3>
        <div className="space-y-2">
          <button className="w-full text-left p-3 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors">
            <div className="flex items-center space-x-3">
              <i className="fas fa-user-plus text-blue-600"></i>
              <span className="text-blue-800 font-medium">Transferir Conversa</span>
            </div>
          </button>
          <button className="w-full text-left p-3 bg-yellow-50 hover:bg-yellow-100 rounded-lg transition-colors">
            <div className="flex items-center space-x-3">
              <i className="fas fa-clock text-yellow-600"></i>
              <span className="text-yellow-800 font-medium">Agendar Follow-up</span>
            </div>
          </button>
          <button className="w-full text-left p-3 bg-red-50 hover:bg-red-100 rounded-lg transition-colors">
            <div className="flex items-center space-x-3">
              <i className="fas fa-ban text-red-600"></i>
              <span className="text-red-800 font-medium">Bloquear Cliente</span>
            </div>
          </button>
          <button className="w-full text-left p-3 bg-green-50 hover:bg-green-100 rounded-lg transition-colors">
            <div className="flex items-center space-x-3">
              <i className="fas fa-file-alt text-green-600"></i>
              <span className="text-green-800 font-medium">Criar Ticket</span>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
