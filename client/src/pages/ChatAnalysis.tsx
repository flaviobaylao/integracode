import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BarChart, Activity, TrendingUp, MessageCircle } from "lucide-react";

export default function ChatAnalysis() {
  const { data: analyses = [] } = useQuery<any[]>({
    queryKey: ["/api/chat/whatsapp/analyses"],
  });

  const { data: conversations = [] } = useQuery<any[]>({
    queryKey: ["/api/chat/conversations"],
  });

  const totalConversations = conversations.length;
  const resolvedConversations = conversations.filter((c: any) => c.status === "resolved").length;
  const avgResolutionRate = totalConversations > 0 
    ? Math.round((resolvedConversations / totalConversations) * 100) 
    : 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-indigo-50">
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Análise de Conversas</h1>
          <p className="text-slate-600 mt-1">Insights e métricas sobre o atendimento via WhatsApp</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total de Conversas</CardTitle>
              <MessageCircle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totalConversations}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {resolvedConversations} resolvidas
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Taxa de Resolução</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{avgResolutionRate}%</div>
              <p className="text-xs text-muted-foreground mt-1">
                Das conversas iniciadas
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Análises IA</CardTitle>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{analyses.length}</div>
              <p className="text-xs text-muted-foreground mt-1">
                Processadas com ChatGPT
              </p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart className="h-5 w-5" />
              Histórico de Análises
            </CardTitle>
            <CardDescription>
              Análises automáticas de conversas do WhatsApp usando ChatGPT
            </CardDescription>
          </CardHeader>
          <CardContent>
            {analyses.length === 0 ? (
              <div className="text-center text-muted-foreground py-12">
                <Activity className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>Nenhuma análise registrada ainda</p>
                <p className="text-sm mt-2">
                  As análises são geradas automaticamente para conversas importantes
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {analyses.map((analysis: any) => (
                  <div key={analysis.id} className="border rounded-lg p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">
                        Conversa #{analysis.conversationId?.substring(0, 8)}
                      </span>
                      <Badge variant={analysis.status === "completed" ? "default" : "outline"}>
                        {analysis.status === "completed" && "Concluída"}
                        {analysis.status === "pending" && "Pendente"}
                        {analysis.status === "failed" && "Falha"}
                      </Badge>
                    </div>
                    {analysis.analysisResult && (
                      <div className="text-sm text-muted-foreground bg-slate-50 p-3 rounded">
                        <pre className="whitespace-pre-wrap">
                          {JSON.stringify(analysis.analysisResult, null, 2)}
                        </pre>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {new Date(analysis.createdAt).toLocaleString("pt-BR")}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
