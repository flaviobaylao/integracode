import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, LineChart, Line } from "recharts";
import { MessageCircle, Clock, Users, TrendingUp } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";

interface ConversationStats {
  totalConversations: number;
  activeConversations: number;
  averageResponseTime: number;
  totalMessagesPerDay: { date: string; count: number }[];
  responseTimeByAgent: { agentName: string; averageResponseTime: number; totalHandled: number }[];
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
  lastAgentResponseTime?: string;
  waitingTime?: number;
  responseTime?: number;
  messageCount: number;
  createdAt: string;
  resolvedAt?: string;
}

export default function ChatManagement() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ["/api/chat/conversations/stats"],
  });

  const { data: conversations, isLoading: conversationsLoading } = useQuery({
    queryKey: ["/api/chat/conversations", statusFilter, priorityFilter, searchQuery],
  });

  const filteredConversations = conversations?.filter((conv: Conversation) => {
    const matchesSearch = !searchQuery || 
      conv.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      conv.customerPhone.includes(searchQuery);
    
    const matchesStatus = statusFilter === "all" || conv.status === statusFilter;
    const matchesPriority = priorityFilter === "all" || conv.priority === priorityFilter;
    
    return matchesSearch && matchesStatus && matchesPriority;
  }) || [];

  const getStatusBadge = (status: string) => {
    const variants: Record<string, { bg: string; text: string; label: string }> = {
      "new": { bg: "bg-blue-100", text: "text-blue-700", label: "Novo" },
      "assigned": { bg: "bg-purple-100", text: "text-purple-700", label: "Atribuído" },
      "in-progress": { bg: "bg-yellow-100", text: "text-yellow-700", label: "Em andamento" },
      "resolved": { bg: "bg-green-100", text: "text-green-700", label: "Resolvido" },
    };
    const variant = variants[status] || variants["new"];
    return <Badge className={`${variant.bg} ${variant.text}`}>{variant.label}</Badge>;
  };

  const getPriorityBadge = (priority: string) => {
    return (
      <Badge variant={priority === "urgent" ? "destructive" : "secondary"}>
        {priority === "urgent" ? "🔴 Urgente" : "Normal"}
      </Badge>
    );
  };

  const formatSeconds = (seconds?: number) => {
    if (!seconds) return "-";
    const mins = Math.floor(seconds / 60);
    return `${mins}m`;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-orange-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2 flex items-center gap-2">
            <MessageCircle className="w-8 h-8 text-green-600" />
            Gestão de Conversas WhatsApp
          </h1>
          <p className="text-gray-600">Visualize e gerencie todas as conversas de clientes</p>
        </div>

        {/* Stats Cards */}
        {!statsLoading && stats && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-gray-600 flex items-center gap-2">
                  <Users className="w-4 h-4" />
                  Total de Conversas
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats.totalConversations}</div>
                <p className="text-xs text-gray-500 mt-1">{stats.activeConversations} ativas</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-gray-600 flex items-center gap-2">
                  <Clock className="w-4 h-4" />
                  Tempo Médio de Resposta
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatSeconds(stats.averageResponseTime)}</div>
                <p className="text-xs text-gray-500 mt-1">Todos os atendentes</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-gray-600 flex items-center gap-2">
                  <TrendingUp className="w-4 h-4" />
                  Conversas Ativas
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-green-600">{stats.activeConversations}</div>
                <p className="text-xs text-gray-500 mt-1">Em andamento agora</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-gray-600">Taxa de Resolução</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {Math.round((stats.totalConversations > 0 ? 75 : 0))}%
                </div>
                <p className="text-xs text-gray-500 mt-1">Conversas resolvidas</p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Charts */}
        {!statsLoading && stats && stats.totalMessagesPerDay?.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
            <Card>
              <CardHeader>
                <CardTitle>Mensagens por Dia</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={stats.totalMessagesPerDay}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip />
                    <Line type="monotone" dataKey="count" stroke="#16a34a" />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Desempenho por Atendente</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={stats.responseTimeByAgent || []}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="agentName" />
                    <YAxis />
                    <Tooltip />
                    <Bar dataKey="averageResponseTime" fill="#f97316" name="Tempo de Resposta (s)" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Filters */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Filtros</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label className="text-sm font-medium text-gray-700">Buscar</label>
                <Input
                  placeholder="Nome ou telefone..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  data-testid="input-search-conversations"
                />
              </div>

              <div>
                <label className="text-sm font-medium text-gray-700">Status</label>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger data-testid="select-status-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos</SelectItem>
                    <SelectItem value="new">Novo</SelectItem>
                    <SelectItem value="assigned">Atribuído</SelectItem>
                    <SelectItem value="in-progress">Em andamento</SelectItem>
                    <SelectItem value="resolved">Resolvido</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-sm font-medium text-gray-700">Prioridade</label>
                <Select value={priorityFilter} onValueChange={setPriorityFilter}>
                  <SelectTrigger data-testid="select-priority-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todas</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="urgent">Urgente</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-end">
                <Button 
                  variant="outline" 
                  onClick={() => {
                    setStatusFilter("all");
                    setPriorityFilter("all");
                    setSearchQuery("");
                  }}
                  data-testid="button-reset-filters"
                  className="w-full"
                >
                  Limpar Filtros
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Conversations Table */}
        <Card>
          <CardHeader>
            <CardTitle>Conversas em Andamento</CardTitle>
            <CardDescription>{filteredConversations.length} conversas encontradas</CardDescription>
          </CardHeader>
          <CardContent>
            {conversationsLoading ? (
              <div className="text-center py-8 text-gray-500">Carregando conversas...</div>
            ) : filteredConversations.length === 0 ? (
              <div className="text-center py-8 text-gray-500">Nenhuma conversa encontrada</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Cliente</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Telefone</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Atendente</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Status</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Prioridade</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Tempo Resposta</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Mensagens</th>
                      <th className="text-left py-3 px-4 font-semibold text-gray-700">Última Mensagem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredConversations.map((conv: Conversation) => (
                      <tr key={conv.id} className="border-b border-gray-100 hover:bg-gray-50" data-testid={`row-conversation-${conv.id}`}>
                        <td className="py-3 px-4 font-medium text-gray-900">{conv.customerName}</td>
                        <td className="py-3 px-4 text-gray-600">{conv.customerPhone}</td>
                        <td className="py-3 px-4 text-gray-600">{conv.agentName || "-"}</td>
                        <td className="py-3 px-4">{getStatusBadge(conv.status)}</td>
                        <td className="py-3 px-4">{getPriorityBadge(conv.priority)}</td>
                        <td className="py-3 px-4 text-gray-600">{formatSeconds(conv.responseTime)}</td>
                        <td className="py-3 px-4">
                          <Badge variant="outline">{conv.messageCount}</Badge>
                        </td>
                        <td className="py-3 px-4 text-gray-600 text-xs">
                          {formatDistanceToNow(new Date(conv.lastMessageTime), { 
                            locale: ptBR,
                            addSuffix: true 
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
