import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileText, MessageSquare, Users, Download, RefreshCw, Search, Clock, User, ShoppingCart, MapPin, CreditCard } from "lucide-react";
import logoImage from "@/assets/logo.jpg";

interface WhatsAppAnalysisPageProps {
  user: any;
  onLogout: () => void;
  onNavigateToAdmin: () => void;
}

export function WhatsAppAnalysisPage({ user, onLogout, onNavigateToAdmin }: WhatsAppAnalysisPageProps) {
  const [activeTab, setActiveTab] = useState("analyses");
  const [selectedAnalysis, setSelectedAnalysis] = useState<any>(null);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");

  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Fetch analyses
  const { data: analyses = [], isLoading: analysesLoading } = useQuery({
    queryKey: ["/api/whatsapp-analysis", statusFilter !== "all" ? { status: statusFilter } : {}],
  });

  // Fetch conversations for analysis
  const { data: conversations = [] } = useQuery({
    queryKey: ["/api/conversations"],
  });

  // Fetch knowledge bases
  const { data: knowledgeBases = [] } = useQuery({
    queryKey: ["/api/whatsapp-analysis/knowledge-base"],
  });

  // Fetch latest knowledge base content
  const { data: latestKnowledgeContent } = useQuery({
    queryKey: ["/api/whatsapp-analysis/knowledge-base/latest/content"],
    enabled: knowledgeBases.length > 0,
  });

  // Analyze conversation mutation
  const analyzeConversationMutation = useMutation({
    mutationFn: async (conversationId: string) => {
      return apiRequest("/api/whatsapp-analysis/analyze/" + conversationId, "POST", {});
    },
    onSuccess: () => {
      toast({
        title: "Sucesso",
        description: "Conversa analisada com sucesso",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp-analysis"] });
      setSelectedConversationId("");
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao analisar conversa",
        variant: "destructive",
      });
    },
  });

  // Generate knowledge base mutation
  const generateKnowledgeMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("/api/whatsapp-analysis/generate-knowledge", "POST", {});
    },
    onSuccess: () => {
      toast({
        title: "Sucesso",
        description: "Base de conhecimento gerada com sucesso",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp-analysis/knowledge-base"] });
      queryClient.invalidateQueries({ queryKey: ["/api/whatsapp-analysis/knowledge-base/latest/content"] });
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao gerar base de conhecimento",
        variant: "destructive",
      });
    },
  });

  const filteredAnalyses = analyses.filter((analysis: any) => {
    const matchesSearch = searchTerm === "" || 
      analysis.customerName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      analysis.companyRepresentative?.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesStatus = statusFilter === "all" || analysis.analysisStatus === statusFilter;
    
    return matchesSearch && matchesStatus;
  });

  const availableConversations = conversations.filter((conv: any) => 
    !analyses.some((analysis: any) => analysis.conversationId === conv.id)
  );

  const formatCurrency = (value: string | null) => {
    if (!value) return "Não informado";
    return `R$ ${value}`;
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return "Não informada";
    return new Date(dateString).toLocaleDateString('pt-BR');
  };

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case "completed": return "default";
      case "pending": return "secondary";
      case "failed": return "destructive";
      default: return "outline";
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-white dark:bg-gray-800">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <img 
              src={logoImage} 
              alt="Logo" 
              className="h-10 w-10 rounded-full" 
              data-testid="logo"
            />
            <div>
              <h1 className="text-2xl font-bold" data-testid="page-title">Análise WhatsApp</h1>
              <p className="text-sm text-muted-foreground">Análise inteligente de conversas comerciais</p>
            </div>
          </div>
          <div className="flex items-center space-x-4">
            <Button
              variant="outline"
              onClick={onNavigateToAdmin}
              data-testid="button-back-admin"
            >
              Voltar ao Admin
            </Button>
            <Button
              variant="ghost"
              onClick={onLogout}
              data-testid="button-logout"
            >
              Sair
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-6">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="analyses" data-testid="tab-analyses">
              <MessageSquare className="mr-2 h-4 w-4" />
              Análises
            </TabsTrigger>
            <TabsTrigger value="analyze" data-testid="tab-analyze">
              <Search className="mr-2 h-4 w-4" />
              Analisar Conversa
            </TabsTrigger>
            <TabsTrigger value="knowledge" data-testid="tab-knowledge">
              <FileText className="mr-2 h-4 w-4" />
              Base de Conhecimento
            </TabsTrigger>
          </TabsList>

          {/* Analyses Tab */}
          <TabsContent value="analyses" className="space-y-6">
            <div className="flex items-center space-x-4">
              <Input
                placeholder="Buscar por cliente ou representante..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="flex-1"
                data-testid="input-search"
              />
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-48" data-testid="select-status-filter">
                  <SelectValue placeholder="Filtrar por status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os status</SelectItem>
                  <SelectItem value="completed">Concluídas</SelectItem>
                  <SelectItem value="pending">Pendentes</SelectItem>
                  <SelectItem value="failed">Falharam</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-4">
              {analysesLoading ? (
                <Card>
                  <CardContent className="flex items-center justify-center py-8">
                    <RefreshCw className="h-6 w-6 animate-spin mr-2" />
                    Carregando análises...
                  </CardContent>
                </Card>
              ) : filteredAnalyses.length === 0 ? (
                <Card>
                  <CardContent className="flex items-center justify-center py-8">
                    <MessageSquare className="h-6 w-6 mr-2 text-muted-foreground" />
                    Nenhuma análise encontrada
                  </CardContent>
                </Card>
              ) : (
                filteredAnalyses.map((analysis: any) => (
                  <Card key={analysis.id} className="hover:shadow-md transition-shadow" data-testid={`analysis-card-${analysis.id}`}>
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                          <User className="h-5 w-5 text-blue-500" />
                          <CardTitle className="text-lg" data-testid={`analysis-customer-${analysis.id}`}>
                            {analysis.customerName || "Cliente não identificado"}
                          </CardTitle>
                        </div>
                        <Badge variant={getStatusBadgeVariant(analysis.analysisStatus)} data-testid={`analysis-status-${analysis.id}`}>
                          {analysis.analysisStatus === "completed" ? "Concluída" : 
                           analysis.analysisStatus === "pending" ? "Pendente" : "Falharam"}
                        </Badge>
                      </div>
                      <CardDescription>
                        <div className="flex items-center space-x-4 text-sm">
                          <span className="flex items-center">
                            <Clock className="h-4 w-4 mr-1" />
                            {formatDate(analysis.analysisDate)}
                          </span>
                          {analysis.companyRepresentative && (
                            <span className="flex items-center">
                              <Users className="h-4 w-4 mr-1" />
                              {analysis.companyRepresentative}
                            </span>
                          )}
                        </div>
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                        <div className="flex items-center space-x-2">
                          <ShoppingCart className="h-4 w-4 text-green-500" />
                          <div>
                            <p className="text-sm font-medium">Valor Total</p>
                            <p className="text-sm text-muted-foreground" data-testid={`analysis-total-${analysis.id}`}>
                              {formatCurrency(analysis.totalAmount)}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center space-x-2">
                          <MessageSquare className="h-4 w-4 text-purple-500" />
                          <div>
                            <p className="text-sm font-medium">Itens do Pedido</p>
                            <p className="text-sm text-muted-foreground">
                              {analysis.orderItems?.length || 0} itens
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center space-x-2">
                          <Clock className="h-4 w-4 text-orange-500" />
                          <div>
                            <p className="text-sm font-medium">Data do Pedido</p>
                            <p className="text-sm text-muted-foreground">
                              {formatDate(analysis.orderDate)}
                            </p>
                          </div>
                        </div>
                      </div>
                      
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button 
                            variant="outline" 
                            size="sm" 
                            onClick={() => setSelectedAnalysis(analysis)}
                            data-testid={`button-view-details-${analysis.id}`}
                          >
                            Ver Detalhes
                          </Button>
                        </DialogTrigger>
                        <DialogContent className="max-w-4xl max-h-[80vh]">
                          <DialogHeader>
                            <DialogTitle>Detalhes da Análise - {analysis.customerName}</DialogTitle>
                            <DialogDescription>
                              Informações completas extraídas da conversa
                            </DialogDescription>
                          </DialogHeader>
                          <ScrollArea className="max-h-[60vh]">
                            <div className="space-y-6">
                              {/* Customer Info */}
                              <div>
                                <h4 className="font-semibold mb-2 flex items-center">
                                  <User className="h-4 w-4 mr-2" />
                                  Informações do Cliente
                                </h4>
                                <div className="grid grid-cols-2 gap-4 p-4 bg-muted rounded-lg">
                                  <div>
                                    <p className="text-sm font-medium">Nome</p>
                                    <p className="text-sm text-muted-foreground">{analysis.customerName || "Não informado"}</p>
                                  </div>
                                  <div>
                                    <p className="text-sm font-medium">Telefone</p>
                                    <p className="text-sm text-muted-foreground">{analysis.extractedData?.customerPhone || "Não informado"}</p>
                                  </div>
                                </div>
                              </div>

                              {/* Commercial Info */}
                              <div>
                                <h4 className="font-semibold mb-2 flex items-center">
                                  <ShoppingCart className="h-4 w-4 mr-2" />
                                  Informações Comerciais
                                </h4>
                                <div className="grid grid-cols-2 gap-4 p-4 bg-muted rounded-lg">
                                  <div>
                                    <p className="text-sm font-medium">Representante</p>
                                    <p className="text-sm text-muted-foreground">{analysis.companyRepresentative || "Não informado"}</p>
                                  </div>
                                  <div>
                                    <p className="text-sm font-medium">Valor Total</p>
                                    <p className="text-sm text-muted-foreground">{formatCurrency(analysis.totalAmount)}</p>
                                  </div>
                                  <div>
                                    <p className="text-sm font-medium">Data do Pedido</p>
                                    <p className="text-sm text-muted-foreground">{formatDate(analysis.orderDate)}</p>
                                  </div>
                                  <div>
                                    <p className="text-sm font-medium">Método de Pagamento</p>
                                    <p className="text-sm text-muted-foreground">{analysis.extractedData?.paymentMethod || "Não informado"}</p>
                                  </div>
                                </div>
                              </div>

                              {/* Order Items */}
                              {analysis.orderItems && analysis.orderItems.length > 0 && (
                                <div>
                                  <h4 className="font-semibold mb-2 flex items-center">
                                    <MessageSquare className="h-4 w-4 mr-2" />
                                    Itens do Pedido
                                  </h4>
                                  <div className="space-y-2">
                                    {analysis.orderItems.map((item: any, index: number) => (
                                      <div key={index} className="p-3 bg-muted rounded-lg">
                                        <div className="flex justify-between items-start">
                                          <div>
                                            <p className="font-medium">{item.productName}</p>
                                            <p className="text-sm text-muted-foreground">
                                              Quantidade: {item.quantity}
                                              {item.size && ` • Tamanho: ${item.size}`}
                                            </p>
                                          </div>
                                          {item.price && (
                                            <p className="font-medium text-green-600">R$ {item.price}</p>
                                          )}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {/* Additional Information */}
                              {(analysis.extractedData?.deliveryAddress || analysis.extractedData?.notes) && (
                                <div>
                                  <h4 className="font-semibold mb-2 flex items-center">
                                    <MapPin className="h-4 w-4 mr-2" />
                                    Informações Adicionais
                                  </h4>
                                  <div className="space-y-2">
                                    {analysis.extractedData?.deliveryAddress && (
                                      <div className="p-3 bg-muted rounded-lg">
                                        <p className="text-sm font-medium">Endereço de Entrega</p>
                                        <p className="text-sm text-muted-foreground">{analysis.extractedData.deliveryAddress}</p>
                                      </div>
                                    )}
                                    {analysis.extractedData?.notes && (
                                      <div className="p-3 bg-muted rounded-lg">
                                        <p className="text-sm font-medium">Observações</p>
                                        <p className="text-sm text-muted-foreground">{analysis.extractedData.notes}</p>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          </ScrollArea>
                        </DialogContent>
                      </Dialog>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          </TabsContent>

          {/* Analyze Tab */}
          <TabsContent value="analyze" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Analisar Nova Conversa</CardTitle>
                <CardDescription>
                  Selecione uma conversa para extrair informações comerciais usando IA
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="conversation-select">Conversa para Análise</Label>
                  <Select value={selectedConversationId} onValueChange={setSelectedConversationId}>
                    <SelectTrigger data-testid="select-conversation">
                      <SelectValue placeholder="Selecione uma conversa..." />
                    </SelectTrigger>
                    <SelectContent>
                      {availableConversations.map((conversation: any) => (
                        <SelectItem key={conversation.id} value={conversation.id}>
                          {conversation.customer.name} - {conversation.customer.phone}
                          {conversation.lastMessage && (
                            <span className="text-xs text-muted-foreground ml-2">
                              ({formatDate(conversation.lastMessage.timestamp)})
                            </span>
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                
                <Button
                  onClick={() => analyzeConversationMutation.mutate(selectedConversationId)}
                  disabled={!selectedConversationId || analyzeConversationMutation.isPending}
                  className="w-full"
                  data-testid="button-analyze-conversation"
                >
                  {analyzeConversationMutation.isPending ? (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                      Analisando...
                    </>
                  ) : (
                    <>
                      <Search className="mr-2 h-4 w-4" />
                      Analisar Conversa
                    </>
                  )}
                </Button>

                {availableConversations.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    <MessageSquare className="h-12 w-12 mx-auto mb-4 opacity-50" />
                    <p>Todas as conversas disponíveis já foram analisadas</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Knowledge Base Tab */}
          <TabsContent value="knowledge" className="space-y-6">
            <div className="flex justify-between items-center">
              <div>
                <h3 className="text-lg font-semibold">Base de Conhecimento</h3>
                <p className="text-sm text-muted-foreground">
                  Arquivos de conhecimento gerados para o ChatGPT
                </p>
              </div>
              <Button
                onClick={() => generateKnowledgeMutation.mutate()}
                disabled={generateKnowledgeMutation.isPending || analyses.filter((a: any) => a.analysisStatus === "completed").length === 0}
                data-testid="button-generate-knowledge"
              >
                {generateKnowledgeMutation.isPending ? (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                    Gerando...
                  </>
                ) : (
                  <>
                    <FileText className="mr-2 h-4 w-4" />
                    Gerar Nova Base
                  </>
                )}
              </Button>
            </div>

            <div className="grid gap-4">
              {knowledgeBases.map((knowledge: any) => (
                <Card key={knowledge.id} data-testid={`knowledge-card-${knowledge.id}`}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-lg">{knowledge.fileName}</CardTitle>
                      <Badge variant={knowledge.isActive ? "default" : "secondary"}>
                        {knowledge.isActive ? "Ativo" : "Inativo"}
                      </Badge>
                    </div>
                    <CardDescription>
                      <div className="flex items-center space-x-4 text-sm">
                        <span>Conversas: {knowledge.conversationCount}</span>
                        <span>Tamanho: {Math.round(knowledge.fileSize / 1024)} KB</span>
                        <span>Gerado: {formatDate(knowledge.lastGenerated)}</span>
                      </div>
                    </CardDescription>
                  </CardHeader>
                </Card>
              ))}
            </div>

            {latestKnowledgeContent && (
              <Card>
                <CardHeader>
                  <CardTitle>Conteúdo da Base de Conhecimento Atual</CardTitle>
                  <CardDescription>
                    Prévia do arquivo que está sendo usado pelo ChatGPT
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-96 w-full rounded-md border p-4">
                    <pre className="text-sm whitespace-pre-wrap" data-testid="knowledge-content">
                      {latestKnowledgeContent.content}
                    </pre>
                  </ScrollArea>
                </CardContent>
              </Card>
            )}

            {knowledgeBases.length === 0 && (
              <Card>
                <CardContent className="flex items-center justify-center py-8">
                  <FileText className="h-6 w-6 mr-2 text-muted-foreground" />
                  Nenhuma base de conhecimento gerada ainda
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}