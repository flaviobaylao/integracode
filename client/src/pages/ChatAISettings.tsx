import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useState, useRef } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useLocation } from "wouter";
import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Bot, Clock, Calendar, Power, Play, Zap, Settings, MessageSquare, AlertCircle, CheckCircle, RefreshCw, Database, Upload, ImageIcon } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import BackToDashboardButton from "@/components/BackToDashboardButton";

interface ChatAiSettings {
  id: string | null;
  isEnabled: boolean;
  mode: 'disabled' | 'manual' | 'schedule' | 'timeout';
  aiProvider: 'openai' | 'grok';
  businessHours: {
    weekdays: string[];
    startTime: string;
    endTime: string;
  } | null;
  timeoutMinutes: number;
  maxTurnsBeforeEscalation: number;
  handoffKeywords: string[];
  systemPrompt: string | null;
  companyContext: string | null;
  gptModel: string;
  assistantId: string | null;
  chatgptQueuePosition: number;
  inactivityTimeoutMinutes: number;
  finalizeMessage: string | null;
  absenceMessage: string | null;
  chatgptImages: string[];
  createdAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

const WEEKDAYS = [
  { value: 'Seg', label: 'Segunda' },
  { value: 'Ter', label: 'Terça' },
  { value: 'Qua', label: 'Quarta' },
  { value: 'Qui', label: 'Quinta' },
  { value: 'Sex', label: 'Sexta' },
  { value: 'Sab', label: 'Sábado' },
  { value: 'Dom', label: 'Domingo' },
];

const GPT_MODELS = [
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini (Rápido e econômico)' },
  { value: 'gpt-4o', label: 'GPT-4o (Mais inteligente)' },
  { value: 'gpt-4-turbo', label: 'GPT-4 Turbo (Alta performance)' },
];

const GROK_MODELS = [
  { value: 'grok-2-1212', label: 'Grok-2 (Mais inteligente - 131k tokens)' },
  { value: 'grok-beta', label: 'Grok Beta (Versão beta)' },
  { value: 'grok-2-vision-1212', label: 'Grok-2 Vision (Com imagens - 8k tokens)' },
];

const AI_PROVIDERS = [
  { value: 'openai', label: 'OpenAI (GPT-4)', icon: '🤖' },
  { value: 'grok', label: 'xAI Grok', icon: '🔮' },
];

function AILogsTable() {
  const { data: logsData, isLoading } = useQuery<{ success: boolean; logs: any[] }>({
    queryKey: ['/api/chat/ai-logs'],
    refetchInterval: 10000,
  });

  if (isLoading) return <div className="flex justify-center p-8"><Loader2 className="h-8 w-8 animate-spin text-honest-orange" /></div>;

  const logs = logsData?.logs || [];

  return (
    <div className="rounded-md border">
      <div className="relative w-full overflow-auto">
        <table className="w-full caption-bottom text-sm">
          <thead className="[&_tr]:border-b bg-gray-50/50">
            <tr className="border-b transition-colors">
              <th className="h-10 px-4 text-left align-middle font-medium">Data/Hora</th>
              <th className="h-10 px-4 text-left align-middle font-medium">Cliente</th>
              <th className="h-10 px-4 text-left align-middle font-medium">Mensagem</th>
              <th className="h-10 px-4 text-left align-middle font-medium">Resposta IA</th>
              <th className="h-10 px-4 text-left align-middle font-medium text-right">Tokens</th>
            </tr>
          </thead>
          <tbody className="[&_tr:last-child]:border-0">
            {logs.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-8 text-center text-muted-foreground">Nenhum log encontrado</td>
              </tr>
            ) : (
              logs.map((log) => (
                <tr key={log.id} className="border-b transition-colors hover:bg-muted/50">
                  <td className="p-4 align-middle whitespace-nowrap">
                    {format(new Date(log.createdAt), 'dd/MM HH:mm', { locale: ptBR })}
                  </td>
                  <td className="p-4 align-middle font-medium">
                    {log.customerPhone}
                  </td>
                  <td className="p-4 align-middle">
                    <div className="max-w-[200px] truncate" title={log.messageContent}>
                      {log.messageContent}
                    </div>
                  </td>
                  <td className="p-4 align-middle">
                    <div className="max-w-[300px] truncate" title={log.responseContent}>
                      {log.responseContent}
                    </div>
                  </td>
                  <td className="p-4 align-middle text-right">{log.tokensUsed || '-'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ChatAISettings() {
  const { user, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [settings, setSettings] = useState<ChatAiSettings>({
    id: null,
    isEnabled: false,
    mode: 'disabled',
    aiProvider: 'openai',
    businessHours: {
      weekdays: ['Seg', 'Ter', 'Qua', 'Qui', 'Sex'],
      startTime: '08:00',
      endTime: '18:00'
    },
    timeoutMinutes: 5,
    maxTurnsBeforeEscalation: 10,
    handoffKeywords: ['atendente', 'humano', 'gerente', 'vendedor', 'reclamação'],
    systemPrompt: null,
    companyContext: null,
    gptModel: 'gpt-4o-mini',
    assistantId: null,
    chatgptQueuePosition: 0,
    inactivityTimeoutMinutes: 30,
    finalizeMessage: 'Atendimento finalizado. Obrigado pelo contato! Caso precise de algo mais, estamos à disposição.',
    absenceMessage: 'No momento não há atendentes disponíveis. Por favor, tente novamente em instantes ou envie sua mensagem que responderemos assim que possível.',
    chatgptImages: [],
    createdAt: null,
    updatedAt: null,
    updatedBy: null
  });

  const [testMessage, setTestMessage] = useState('');
  const [testResponse, setTestResponse] = useState<{ response?: string; shouldTransfer?: boolean; transferReason?: string; tokensUsed?: number; responseTimeMs?: number } | null>(null);
  const [newKeyword, setNewKeyword] = useState('');
  const [newImageUrl, setNewImageUrl] = useState('');
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: settingsData, isLoading: isLoadingSettings } = useQuery<{ success: boolean; settings: ChatAiSettings }>({
    queryKey: ['/api/chat/ai-settings'],
  });

  useEffect(() => {
    if (settingsData?.settings) {
      setSettings(settingsData.settings);
    }
  }, [settingsData]);

  useEffect(() => {
    if (!authLoading && user?.role !== 'admin' && user?.role !== 'coordinator') {
      setLocation('/');
    }
  }, [user, authLoading, setLocation]);

  const updateMutation = useMutation({
    mutationFn: async (data: Partial<ChatAiSettings>) => {
      return await apiRequest('PUT', '/api/chat/ai-settings', data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/chat/ai-settings'] });
      toast({ title: 'Configurações salvas com sucesso!' });
    },
    onError: (error: any) => {
      toast({ title: 'Erro ao salvar configurações', description: error.message, variant: 'destructive' });
    }
  });

  const toggleMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest('POST', '/api/chat/ai-settings/toggle');
    },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ['/api/chat/ai-settings'] });
      toast({ 
        title: data.enabled ? 'ChatGPT Ativado!' : 'ChatGPT Desativado',
        description: data.enabled ? 'O atendimento automático está agora ativo.' : 'O atendimento automático foi pausado.'
      });
    },
    onError: (error: any) => {
      toast({ title: 'Erro ao alternar', description: error.message, variant: 'destructive' });
    }
  });

  const testMutation = useMutation({
    mutationFn: async (message: string) => {
      return await apiRequest('POST', '/api/chat/test-ai-response', { message });
    },
    onSuccess: (data: any) => {
      setTestResponse(data);
    },
    onError: (error: any) => {
      toast({ title: 'Erro no teste', description: error.message, variant: 'destructive' });
    }
  });

  const refreshReportsMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest('POST', '/api/chat/ai-reports/refresh');
    },
    onSuccess: () => {
      toast({ title: 'Relatórios atualizados!', description: 'Os dados de clientes, débitos e faturamentos foram regenerados.' });
    },
    onError: (error: any) => {
      toast({ title: 'Erro ao atualizar relatórios', description: error.message, variant: 'destructive' });
    }
  });

  const handleSave = () => {
    updateMutation.mutate(settings);
  };

  const handleWeekdayToggle = (day: string) => {
    const currentDays = settings.businessHours?.weekdays || [];
    const newDays = currentDays.includes(day)
      ? currentDays.filter(d => d !== day)
      : [...currentDays, day];
    
    setSettings({
      ...settings,
      businessHours: {
        ...settings.businessHours!,
        weekdays: newDays
      }
    });
  };

  const handleAddKeyword = () => {
    if (newKeyword.trim() && !settings.handoffKeywords.includes(newKeyword.trim())) {
      setSettings({
        ...settings,
        handoffKeywords: [...settings.handoffKeywords, newKeyword.trim()]
      });
      setNewKeyword('');
    }
  };

  const handleRemoveKeyword = (keyword: string) => {
    setSettings({
      ...settings,
      handoffKeywords: settings.handoffKeywords.filter(k => k !== keyword)
    });
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsUploadingImage(true);
    try {
      const uploadedUrls: string[] = [];
      
      for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) {
          toast({ title: 'Erro', description: `${file.name} não é uma imagem válida`, variant: 'destructive' });
          continue;
        }

        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch('/api/chat/upload', {
          method: 'POST',
          body: formData,
          credentials: 'include'
        });

        if (!response.ok) {
          throw new Error(`Erro ao fazer upload de ${file.name}`);
        }

        const data = await response.json();
        if (data.file?.url) {
          uploadedUrls.push(data.file.url);
        }
      }

      if (uploadedUrls.length > 0) {
        const newImages = [...(settings.chatgptImages || []), ...uploadedUrls];
        setSettings({ ...settings, chatgptImages: newImages });
        updateMutation.mutate({ chatgptImages: newImages });
        toast({ title: 'Sucesso', description: `${uploadedUrls.length} imagem(ns) adicionada(s)` });
      }
    } catch (error: any) {
      toast({ title: 'Erro no upload', description: error.message, variant: 'destructive' });
    } finally {
      setIsUploadingImage(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  if (authLoading || isLoadingSettings) {
    return (
      <div className="flex items-center justify-center min-h-screen" data-testid="loading-spinner">
        <Loader2 className="h-8 w-8 animate-spin text-honest-orange" />
      </div>
    );
  }

  if (user?.role !== 'admin' && user?.role !== 'coordinator') {
    return null;
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold mb-2 flex items-center gap-3" data-testid="page-title">
            <Bot className="h-8 w-8 text-honest-orange" />
            Configurações do ChatGPT
          </h1>
          <p className="text-muted-foreground">
            Configure o atendimento automático via ChatGPT
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => refreshReportsMutation.mutate()}
            disabled={refreshReportsMutation.isPending}
            data-testid="refresh-reports-button"
          >
            {refreshReportsMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Atualizar Dados
          </Button>
          <div className="flex items-center gap-2">
            <Badge 
              variant={settings.isEnabled ? "default" : "secondary"}
              className={settings.isEnabled ? "bg-green-500" : ""}
              data-testid="status-badge"
            >
              {settings.isEnabled ? "Ativo" : "Inativo"}
            </Badge>
            <Button
              variant={settings.isEnabled ? "destructive" : "default"}
              size="sm"
              onClick={() => toggleMutation.mutate()}
              disabled={toggleMutation.isPending}
              data-testid="toggle-ai-button"
            >
              {toggleMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Power className="h-4 w-4 mr-2" />
              )}
              {settings.isEnabled ? "Desativar" : "Ativar"}
            </Button>
          </div>
          <BackToDashboardButton />
        </div>
      </div>

      <Tabs defaultValue="general" className="space-y-6">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="general" data-testid="tab-general">
            <Settings className="h-4 w-4 mr-2" />
            Geral
          </TabsTrigger>
          <TabsTrigger value="schedule" data-testid="tab-schedule">
            <Calendar className="h-4 w-4 mr-2" />
            Horário
          </TabsTrigger>
          <TabsTrigger value="prompts" data-testid="tab-prompts">
            <MessageSquare className="h-4 w-4 mr-2" />
            Prompts
          </TabsTrigger>
          <TabsTrigger value="logs" data-testid="tab-logs">
            <Clock className="h-4 w-4 mr-2" />
            Atividade
          </TabsTrigger>
          <TabsTrigger value="test" data-testid="tab-test">
            <Zap className="h-4 w-4 mr-2" />
            Testar
          </TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Modo de Operação</CardTitle>
              <CardDescription>
                Configure como o ChatGPT deve responder às mensagens dos clientes
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <Label>Modo de Atendimento</Label>
                <Select
                  value={settings.mode}
                  onValueChange={(value: 'disabled' | 'manual' | 'schedule' | 'timeout') => 
                    setSettings({ ...settings, mode: value })
                  }
                  data-testid="select-mode"
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="disabled">
                      <span className="flex items-center gap-2">
                        <Power className="h-4 w-4 text-gray-400" />
                        Desativado - Apenas atendimento humano
                      </span>
                    </SelectItem>
                    <SelectItem value="manual">
                      <span className="flex items-center gap-2">
                        <Play className="h-4 w-4 text-green-500" />
                        Manual - Sempre ativo (quando habilitado)
                      </span>
                    </SelectItem>
                    <SelectItem value="schedule">
                      <span className="flex items-center gap-2">
                        <Calendar className="h-4 w-4 text-blue-500" />
                        Horário - Ativo apenas fora do expediente
                      </span>
                    </SelectItem>
                    <SelectItem value="timeout">
                      <span className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-orange-500" />
                        Timeout - Assume após X minutos sem resposta humana
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>

                {settings.mode === 'timeout' && (
                  <div className="mt-4 space-y-2">
                    <Label>Tempo de espera (minutos)</Label>
                    <Input
                      type="number"
                      min={1}
                      max={60}
                      value={settings.timeoutMinutes}
                      onChange={(e) => setSettings({ ...settings, timeoutMinutes: parseInt(e.target.value) || 5 })}
                      className="w-32"
                      data-testid="input-timeout"
                    />
                    <p className="text-sm text-muted-foreground">
                      ChatGPT assumirá a conversa se nenhum atendente responder em {settings.timeoutMinutes} minutos
                    </p>
                  </div>
                )}
              </div>

              <div className="space-y-4 pt-4 border-t">
                <Label>Provedor de IA</Label>
                <Select
                  value={settings.aiProvider}
                  onValueChange={(value: 'openai' | 'grok') => {
                    const defaultModel = value === 'grok' ? 'grok-2-1212' : 'gpt-4o-mini';
                    setSettings({ ...settings, aiProvider: value, gptModel: defaultModel });
                  }}
                  data-testid="select-provider"
                >
                  <SelectTrigger className="w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AI_PROVIDERS.map(provider => (
                      <SelectItem key={provider.value} value={provider.value}>
                        <span className="flex items-center gap-2">
                          <span>{provider.icon}</span>
                          {provider.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground">
                  Escolha entre OpenAI (GPT-4) ou xAI Grok para responder às mensagens
                </p>
              </div>

              {settings.aiProvider === 'openai' && (
                <div className="space-y-4 pt-4 border-t">
                  <div className="space-y-2">
                    <Label htmlFor="assistantId">ID do Assistente OpenAI (opcional)</Label>
                    <Input
                      id="assistantId"
                      placeholder="asst_4AM6M50fsOXKXlz5Ijc7IA9k"
                      value={settings.assistantId || ''}
                      onChange={(e) => setSettings({ ...settings, assistantId: e.target.value || null })}
                      className="w-full max-w-md font-mono"
                      data-testid="input-assistant-id"
                    />
                    <p className="text-sm text-muted-foreground">
                      Insira o ID do assistente criado no OpenAI Platform (ex: asst_xxxxx).
                      O sistema usará este assistente para responder às mensagens dos clientes.
                    </p>
                  </div>
                </div>
              )}

              <div className="space-y-4 pt-4 border-t">
                <Label>Modelo de IA</Label>
                <Select
                  value={settings.gptModel}
                  onValueChange={(value) => setSettings({ ...settings, gptModel: value })}
                  data-testid="select-model"
                >
                  <SelectTrigger className="w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(settings.aiProvider === 'grok' ? GROK_MODELS : GPT_MODELS).map(model => (
                      <SelectItem key={model.value} value={model.value}>
                        {model.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground">
                  {settings.aiProvider === 'grok' 
                    ? 'Modelo Grok usado para responder às mensagens' 
                    : 'Modelo usado caso nenhum assistente seja configurado'}
                </p>
              </div>

              <div className="space-y-4 pt-4 border-t">
                <Label>Limite de turnos antes de escalonar</Label>
                <Input
                  type="number"
                  min={3}
                  max={50}
                  value={settings.maxTurnsBeforeEscalation}
                  onChange={(e) => setSettings({ ...settings, maxTurnsBeforeEscalation: parseInt(e.target.value) || 10 })}
                  className="w-32"
                  data-testid="input-max-turns"
                />
                <p className="text-sm text-muted-foreground">
                  Após {settings.maxTurnsBeforeEscalation} mensagens, o ChatGPT sugerirá transferir para humano
                </p>
              </div>

              <div className="space-y-4 pt-4 border-t">
                <Label className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-purple-500" />
                  Posição do ChatGPT na Fila de Atendimento
                </Label>
                <Select
                  value={String(settings.chatgptQueuePosition)}
                  onValueChange={(value) => setSettings({ ...settings, chatgptQueuePosition: parseInt(value) })}
                  data-testid="select-queue-position"
                >
                  <SelectTrigger className="w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">
                      <span className="flex items-center gap-2">
                        <span className="text-gray-400">🔄</span>
                        Standby - Só atende quando não há humanos online
                      </span>
                    </SelectItem>
                    <SelectItem value="1">
                      <span className="flex items-center gap-2">
                        <span className="text-green-500">🥇</span>
                        Primeiro - ChatGPT atende todas as conversas primeiro
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground">
                  {settings.chatgptQueuePosition === 1 
                    ? "O ChatGPT receberá todas as novas conversas primeiro. Os atendentes humanos podem assumir quando necessário."
                    : "O ChatGPT só assumirá conversas quando não houver atendentes humanos online (modo standby)."}
                </p>
                {settings.chatgptQueuePosition === 1 && (
                  <Alert className="mt-2">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      Com esta configuração, o ChatGPT atenderá primeiro todas as conversas antes dos atendentes humanos.
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Palavras-chave para Transferência</CardTitle>
              <CardDescription>
                Quando o cliente mencionar essas palavras, será transferido para atendente humano
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {settings.handoffKeywords.map((keyword) => (
                  <Badge
                    key={keyword}
                    variant="secondary"
                    className="cursor-pointer hover:bg-red-100"
                    onClick={() => handleRemoveKeyword(keyword)}
                    data-testid={`keyword-${keyword}`}
                  >
                    {keyword} ✕
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="Nova palavra-chave..."
                  value={newKeyword}
                  onChange={(e) => setNewKeyword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddKeyword()}
                  className="w-64"
                  data-testid="input-new-keyword"
                />
                <Button variant="outline" onClick={handleAddKeyword} data-testid="button-add-keyword">
                  Adicionar
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Imagens do ChatGPT</CardTitle>
              <CardDescription>
                URLs de imagens que o ChatGPT pode enviar durante conversas com clientes
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                {(settings.chatgptImages || []).map((imageUrl, index) => (
                  <div key={index} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                    <img 
                      src={imageUrl} 
                      alt={`Imagem ${index + 1}`}
                      className="w-16 h-16 object-cover rounded border"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect fill="%23ddd" width="64" height="64"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%23999" font-size="10">Erro</text></svg>';
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{imageUrl}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-500 hover:text-red-700 hover:bg-red-50"
                      onClick={() => {
                        const newImages = [...(settings.chatgptImages || [])];
                        newImages.splice(index, 1);
                        setSettings({ ...settings, chatgptImages: newImages });
                        updateMutation.mutate({ chatgptImages: newImages });
                      }}
                    >
                      Remover
                    </Button>
                  </div>
                ))}
                {(settings.chatgptImages || []).length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    Nenhuma imagem cadastrada
                  </p>
                )}
              </div>
              <div className="border-2 border-dashed border-gray-200 rounded-lg p-4 text-center">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleImageUpload}
                  accept="image/*"
                  multiple
                  className="hidden"
                  data-testid="input-image-file"
                />
                <Button
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploadingImage}
                  className="w-full"
                  data-testid="button-upload-image"
                >
                  {isUploadingImage ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Enviando...
                    </>
                  ) : (
                    <>
                      <Upload className="h-4 w-4 mr-2" />
                      Fazer Upload de Imagem
                    </>
                  )}
                </Button>
                <p className="text-xs text-muted-foreground mt-2">
                  Clique para selecionar imagens do seu computador
                </p>
              </div>

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-white px-2 text-muted-foreground">ou cole uma URL</span>
                </div>
              </div>

              <div className="flex gap-2">
                <Input
                  placeholder="Cole a URL da imagem aqui..."
                  value={newImageUrl}
                  onChange={(e) => setNewImageUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newImageUrl.trim()) {
                      const newImages = [...(settings.chatgptImages || []), newImageUrl.trim()];
                      setSettings({ ...settings, chatgptImages: newImages });
                      updateMutation.mutate({ chatgptImages: newImages });
                      setNewImageUrl('');
                    }
                  }}
                  className="flex-1"
                  data-testid="input-new-image-url"
                />
                <Button 
                  variant="outline" 
                  onClick={() => {
                    if (newImageUrl.trim()) {
                      const newImages = [...(settings.chatgptImages || []), newImageUrl.trim()];
                      setSettings({ ...settings, chatgptImages: newImages });
                      updateMutation.mutate({ chatgptImages: newImages });
                      setNewImageUrl('');
                    }
                  }}
                  data-testid="button-add-image"
                >
                  Adicionar
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="h-5 w-5" />
                Finalização e Ausência
              </CardTitle>
              <CardDescription>
                Configure mensagens automáticas de finalização de atendimento e ausência de atendentes
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label>Tempo de Inatividade para Finalização Automática (minutos)</Label>
                <Input
                  type="number"
                  min={5}
                  max={120}
                  value={settings.inactivityTimeoutMinutes}
                  onChange={(e) => setSettings({ ...settings, inactivityTimeoutMinutes: parseInt(e.target.value) || 30 })}
                  className="w-32"
                  data-testid="input-inactivity-timeout"
                />
                <p className="text-sm text-muted-foreground">
                  Conversas sem atividade por {settings.inactivityTimeoutMinutes} minutos serão finalizadas automaticamente
                </p>
              </div>

              <div className="space-y-2">
                <Label>Mensagem de Finalização</Label>
                <Textarea
                  placeholder="Mensagem enviada ao cliente quando a conversa é finalizada..."
                  value={settings.finalizeMessage || ''}
                  onChange={(e) => setSettings({ ...settings, finalizeMessage: e.target.value })}
                  className="min-h-[80px]"
                  data-testid="input-finalize-message"
                />
                <p className="text-sm text-muted-foreground">
                  Mensagem enviada ao cliente quando o atendente finaliza a conversa ou por inatividade
                </p>
              </div>

              <div className="space-y-2">
                <Label>Mensagem de Ausência</Label>
                <Textarea
                  placeholder="Mensagem enviada quando não há atendentes disponíveis..."
                  value={settings.absenceMessage || ''}
                  onChange={(e) => setSettings({ ...settings, absenceMessage: e.target.value })}
                  className="min-h-[80px]"
                  data-testid="input-absence-message"
                />
                <p className="text-sm text-muted-foreground">
                  Mensagem enviada ao cliente quando não há atendentes online e o ChatGPT está desativado
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="schedule" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Calendar className="h-5 w-5" />
                Horário de Funcionamento do ChatGPT
              </CardTitle>
              <CardDescription>
                {settings.mode === 'schedule' 
                  ? "O ChatGPT responderá FORA deste horário (quando não há atendentes)"
                  : "Configure o horário para usar o modo 'Horário' de operação"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <Label>Dias da Semana (quando ChatGPT NÃO deve atender)</Label>
                <div className="flex flex-wrap gap-4">
                  {WEEKDAYS.map(day => (
                    <div key={day.value} className="flex items-center space-x-2">
                      <Checkbox
                        id={day.value}
                        checked={settings.businessHours?.weekdays.includes(day.value)}
                        onCheckedChange={() => handleWeekdayToggle(day.value)}
                        data-testid={`checkbox-${day.value}`}
                      />
                      <label htmlFor={day.value} className="text-sm cursor-pointer">
                        {day.label}
                      </label>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Horário de Início (expediente humano)</Label>
                  <Input
                    type="time"
                    value={settings.businessHours?.startTime || '08:00'}
                    onChange={(e) => setSettings({
                      ...settings,
                      businessHours: { ...settings.businessHours!, startTime: e.target.value }
                    })}
                    data-testid="input-start-time"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Horário de Fim (expediente humano)</Label>
                  <Input
                    type="time"
                    value={settings.businessHours?.endTime || '18:00'}
                    onChange={(e) => setSettings({
                      ...settings,
                      businessHours: { ...settings.businessHours!, endTime: e.target.value }
                    })}
                    data-testid="input-end-time"
                  />
                </div>
              </div>

              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  No modo <strong>Horário</strong>, o ChatGPT responderá automaticamente quando não houver 
                  expediente configurado acima. Por exemplo, se o expediente é das 8h às 18h, 
                  o ChatGPT atenderá das 18h às 8h do dia seguinte.
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="prompts" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Prompt do Sistema</CardTitle>
              <CardDescription>
                Instruções detalhadas de como o ChatGPT deve se comportar (deixe vazio para usar o padrão)
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                placeholder="Você é um assistente virtual da empresa Honest Sucos..."
                value={settings.systemPrompt || ''}
                onChange={(e) => setSettings({ ...settings, systemPrompt: e.target.value || null })}
                rows={10}
                className="font-mono text-sm"
                data-testid="textarea-system-prompt"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Contexto da Empresa</CardTitle>
              <CardDescription>
                Informações sobre a empresa que o ChatGPT deve conhecer (produtos, horários, etc)
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                placeholder="A Honest Sucos é uma empresa de sucos naturais localizada em Goiânia-GO..."
                value={settings.companyContext || ''}
                onChange={(e) => setSettings({ ...settings, companyContext: e.target.value || null })}
                rows={8}
                className="font-mono text-sm"
                data-testid="textarea-company-context"
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="logs" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Log de Atividade da IA</CardTitle>
              <CardDescription>
                Últimas interações do atendimento automático
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AILogsTable />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="test" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5 text-yellow-500" />
                Testar Resposta do ChatGPT
              </CardTitle>
              <CardDescription>
                Envie uma mensagem de teste para ver como o ChatGPT responderia
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Mensagem do Cliente (simulação)</Label>
                <Textarea
                  placeholder="Olá, quais produtos vocês têm disponíveis?"
                  value={testMessage}
                  onChange={(e) => setTestMessage(e.target.value)}
                  rows={3}
                  data-testid="textarea-test-message"
                />
              </div>
              
              <Button 
                onClick={() => testMutation.mutate(testMessage)}
                disabled={!testMessage.trim() || testMutation.isPending}
                data-testid="button-test-response"
              >
                {testMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Gerando resposta...
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 mr-2" />
                    Testar Resposta
                  </>
                )}
              </Button>

              {testResponse && (
                <div className="mt-4 space-y-4">
                  <div className="p-4 bg-green-50 dark:bg-green-950 rounded-lg border border-green-200">
                    <Label className="text-green-700 dark:text-green-300">Resposta do ChatGPT:</Label>
                    <p className="mt-2 text-gray-800 dark:text-gray-200" data-testid="test-response">
                      {testResponse.response}
                    </p>
                  </div>
                  
                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    <span>Tokens usados: {testResponse.tokensUsed}</span>
                    <span>Tempo: {testResponse.responseTimeMs}ms</span>
                    {testResponse.shouldTransfer && (
                      <Badge variant="destructive">
                        Transferir para humano: {testResponse.transferReason}
                      </Badge>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <div className="flex justify-end gap-4 pt-4 border-t">
        <Button 
          variant="outline" 
          onClick={() => setLocation('/telemarketing')}
          data-testid="button-cancel"
        >
          Cancelar
        </Button>
        <Button 
          onClick={handleSave}
          disabled={updateMutation.isPending}
          data-testid="button-save"
        >
          {updateMutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Salvando...
            </>
          ) : (
            <>
              <CheckCircle className="h-4 w-4 mr-2" />
              Salvar Configurações
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
