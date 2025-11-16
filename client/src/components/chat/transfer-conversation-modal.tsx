import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Users, UserCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Agent } from "@shared/schema";

interface TransferConversationModalProps {
  isOpen: boolean;
  onClose: () => void;
  conversationId: string;
  currentAgentId: string;
}

export function TransferConversationModal({ 
  isOpen, 
  onClose, 
  conversationId,
  currentAgentId 
}: TransferConversationModalProps) {
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const { toast } = useToast();

  // Fetch online agents
  const { data: onlineAgents, isLoading } = useQuery<Agent[]>({
    queryKey: ["/api/agents/online"],
    enabled: isOpen,
  });

  // Filter out current agent
  const availableAgents = onlineAgents?.filter(agent => agent.id !== currentAgentId) || [];

  // Transfer conversation mutation
  const transferMutation = useMutation({
    mutationFn: async (targetAgentId: string) => {
      const response = await apiRequest("POST", `/api/conversations/${conversationId}/transfer`, {
        targetAgentId
      });
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Sucesso",
        description: "Conversa transferida com sucesso",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      onClose();
      setSelectedAgentId("");
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao transferir conversa",
        variant: "destructive",
      });
    },
  });

  const handleTransfer = () => {
    if (!selectedAgentId) {
      toast({
        title: "Erro",
        description: "Selecione um agente para transferir",
        variant: "destructive",
      });
      return;
    }
    transferMutation.mutate(selectedAgentId);
  };

  const handleClose = () => {
    if (!transferMutation.isPending) {
      onClose();
      setSelectedAgentId("");
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md" data-testid="modal-transfer-conversation">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Transferir Conversa
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="text-sm text-muted-foreground">
            Selecione o agente para quem deseja transferir esta conversa
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-sm text-muted-foreground">Carregando agentes online...</div>
            </div>
          ) : availableAgents.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-center">
                <Users className="h-12 w-12 mx-auto text-muted-foreground mb-2" />
                <div className="text-sm text-muted-foreground">
                  Nenhum agente online disponível para transferência
                </div>
              </div>
            </div>
          ) : (
            <>
              <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
                <SelectTrigger data-testid="select-target-agent">
                  <SelectValue placeholder="Selecione um agente" />
                </SelectTrigger>
                <SelectContent>
                  {availableAgents.filter(agent => agent.id && agent.id.trim() !== '').map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      <div className="flex items-center gap-2">
                        <Avatar className="h-6 w-6">
                          <AvatarFallback className="text-xs">
                            {agent.name.charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span>{agent.name}</span>
                        <Badge variant="secondary" className="ml-auto">
                          {agent.activeConversations} conversas
                        </Badge>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {selectedAgentId && (
                <Card>
                  <CardContent className="pt-4">
                    {(() => {
                      const selectedAgent = availableAgents.find(a => a.id === selectedAgentId);
                      return selectedAgent ? (
                        <div className="flex items-center gap-3">
                          <Avatar className="h-8 w-8">
                            <AvatarFallback>
                              {selectedAgent.name.charAt(0).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex-1">
                            <div className="font-medium">{selectedAgent.name}</div>
                            <div className="text-sm text-muted-foreground">
                              {selectedAgent.activeConversations} conversas ativas
                            </div>
                          </div>
                          <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                            <UserCheck className="h-3 w-3 mr-1" />
                            Online
                          </Badge>
                        </div>
                      ) : null;
                    })()}
                  </CardContent>
                </Card>
              )}
            </>
          )}

          <div className="flex gap-2 pt-4">
            <Button 
              variant="outline" 
              onClick={handleClose}
              disabled={transferMutation.isPending}
              className="flex-1"
              data-testid="button-cancel-transfer"
            >
              Cancelar
            </Button>
            <Button 
              onClick={handleTransfer}
              disabled={!selectedAgentId || transferMutation.isPending || availableAgents.length === 0}
              className="flex-1"
              data-testid="button-confirm-transfer"
            >
              {transferMutation.isPending ? "Transferindo..." : "Transferir"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}