import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import BackToDashboardButton from "@/components/BackToDashboardButton";

export default function AgentManagement() {
  const { toast } = useToast();
  const [selectedConvId, setSelectedConvId] = useState<string>("");
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");

  const { data: stats, isLoading } = useQuery({
    queryKey: ["/api/chat/agents/stats"],
    refetchInterval: 3000,
  });

  const { data: agents } = useQuery({
    queryKey: ["/api/chat/agents"],
  });

  const handleTransfer = async () => {
    if (!selectedConvId || !selectedAgentId) {
      toast({ title: "Erro", description: "Selecione conversa e agente", variant: "destructive" });
      return;
    }

    try {
      const res = await fetch(`/api/chat/conversations/${selectedConvId}/transfer`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newAgentId: selectedAgentId })
      });

      if (!res.ok) throw new Error("Erro ao transferir");
      
      toast({ title: "Sucesso", description: "Conversa transferida com sucesso" });
      setSelectedConvId("");
      setSelectedAgentId("");
      queryClient.invalidateQueries({ queryKey: ["/api/chat/agents/stats"] });
    } catch (error) {
      toast({ title: "Erro", description: "Falha ao transferir conversa", variant: "destructive" });
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-purple-50 p-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Gerenciamento de Atendentes</h1>
            <p className="text-gray-600">Visualize e gerencie conversas por atendente</p>
          </div>
          <BackToDashboardButton />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Stats */}
          <div className="lg:col-span-3">
            <Card>
              <CardHeader>
                <CardTitle>Conversas em Andamento por Atendente</CardTitle>
                <CardDescription>Total de conversas ativas por agente</CardDescription>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="text-center py-8 text-gray-500">Carregando...</div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    {stats?.map((stat: any) => (
                      <div key={stat.agentId || "unassigned"} className="border rounded-lg p-4 hover:shadow-md transition">
                        <p className="font-semibold text-sm text-gray-600">{stat.agentName}</p>
                        <p className="text-2xl font-bold text-blue-600 mt-2">{stat.count}</p>
                        <p className="text-xs text-gray-500 mt-2">conversas ativas</p>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Transfer */}
          <div className="lg:col-span-3">
            <Card>
              <CardHeader>
                <CardTitle>Transferir Conversa</CardTitle>
                <CardDescription>Transfira uma conversa entre atendentes</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <label className="text-sm font-medium">Selecionar Conversa</label>
                  <Select value={selectedConvId} onValueChange={setSelectedConvId}>
                    <SelectTrigger data-testid="select-conversation">
                      <SelectValue placeholder="Escolha uma conversa..." />
                    </SelectTrigger>
                    <SelectContent>
                      {stats?.flatMap((stat: any) =>
                        stat.conversations?.map((conv: any) => (
                          <SelectItem key={conv.id} value={conv.id}>
                            {conv.customerName} - {conv.customerPhone}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <label className="text-sm font-medium">Transferir Para</label>
                  <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
                    <SelectTrigger data-testid="select-agent">
                      <SelectValue placeholder="Escolha um atendente..." />
                    </SelectTrigger>
                    <SelectContent>
                      {agents?.map((agent: any) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Button onClick={handleTransfer} className="w-full bg-blue-600 hover:bg-blue-700" data-testid="button-transfer">
                  Transferir
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
