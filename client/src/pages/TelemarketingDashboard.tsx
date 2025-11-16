import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MessageSquare, Users, Package, TrendingUp, MessageCircle } from "lucide-react";
import { ChatArea } from "@/components/chat/chat-area";
import { ConversationList } from "@/components/chat/conversation-list";
import { AgentPanel } from "@/components/chat/agent-panel";
import { useState } from "react";
import type { ChatConversationWithCustomer, ChatAgent } from "@shared/schema";

export default function TelemarketingDashboard() {
  const [selectedConversation, setSelectedConversation] = useState<ChatConversationWithCustomer | null>(null);

  const { data: conversations = [] } = useQuery<ChatConversationWithCustomer[]>({
    queryKey: ["/api/chat/conversations"],
  });

  const { data: agents = [] } = useQuery<ChatAgent[]>({
    queryKey: ["/api/chat/agents"],
  });

  const activeConversations = conversations.filter((c) => c.status !== "resolved");
  const resolvedToday = conversations.filter((c) => {
    const conversation = c as any;
    return c.status === "resolved" && 
      conversation.updatedAt && 
      new Date(conversation.updatedAt).toDateString() === new Date().toDateString();
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-50">
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Chat Honest</h1>
            <p className="text-slate-600 mt-1">Sistema de atendimento integrado WhatsApp & Telegram</p>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Conversas Ativas</CardTitle>
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{activeConversations.length}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Resolvidas Hoje</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{resolvedToday.length}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Agentes Online</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {agents.filter((a) => a.status === "online").length}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Conversas</CardTitle>
              <Package className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{conversations.length}</div>
            </CardContent>
          </Card>
        </div>

        {/* Chat Interface */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-[calc(100vh-320px)]">
          <div className="lg:col-span-3">
            <ConversationList
              conversations={conversations}
              selectedConversation={selectedConversation}
              onSelectConversation={setSelectedConversation}
            />
          </div>

          <div className="lg:col-span-6">
            {selectedConversation ? (
              <ChatArea conversation={selectedConversation} />
            ) : (
              <Card className="h-full flex items-center justify-center">
                <div className="text-center text-muted-foreground">
                  <MessageCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>Selecione uma conversa para começar</p>
                </div>
              </Card>
            )}
          </div>

          <div className="lg:col-span-3">
            {selectedConversation && (
              <AgentPanel conversation={selectedConversation} agents={agents} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
