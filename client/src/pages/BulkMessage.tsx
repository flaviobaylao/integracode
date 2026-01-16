import { useState, useRef, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { 
  Loader2, Upload, Send, Download, Users, Phone, CheckCircle, 
  AlertCircle, FileSpreadsheet, Clock, X, Info, Pause, Play, Square
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import BackToDashboardButton from "@/components/BackToDashboardButton";

interface Contact {
  phone: string;
  name: string;
  valid: boolean;
}

interface ParseResult {
  success: boolean;
  totalRows: number;
  validContacts: number;
  contacts: Contact[];
}

interface JobStatus {
  active: boolean;
  status?: 'running' | 'paused' | 'stopped' | 'completed';
  totalContacts?: number;
  sentCount?: number;
  successCount?: number;
  errorCount?: number;
  progress?: number;
}

export default function BulkMessage() {
  const { user, isLoading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [message, setMessage] = useState("");
  const [delaySeconds, setDelaySeconds] = useState(3);
  const [parseStats, setParseStats] = useState<{ totalRows: number; validContacts: number } | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ totalContacts: number; estimatedTimeMinutes: number } | null>(null);

  // Polling do status do disparo
  const { data: jobStatus, refetch: refetchStatus } = useQuery<JobStatus>({
    queryKey: ["/api/chat/bulk-message/status"],
    refetchInterval: isSending ? 2000 : false,
    enabled: isSending,
  });

  // Atualizar estado baseado no status do job
  useEffect(() => {
    if (jobStatus) {
      if (jobStatus.status === 'completed' || jobStatus.status === 'stopped') {
        setIsSending(false);
        if (jobStatus.status === 'completed') {
          toast({
            title: "Disparo concluído!",
            description: `${jobStatus.successCount || 0} mensagens enviadas com sucesso, ${jobStatus.errorCount || 0} erros.`,
          });
        }
      }
    }
  }, [jobStatus]);

  const parseMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      
      const response = await fetch("/api/chat/bulk-message/parse", {
        method: "POST",
        body: formData,
        credentials: "include"
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Erro ao processar planilha");
      }
      
      return response.json() as Promise<ParseResult>;
    },
    onSuccess: (data) => {
      setContacts(data.contacts);
      setParseStats({ totalRows: data.totalRows, validContacts: data.validContacts });
      toast({ 
        title: "Planilha processada!",
        description: `${data.validContacts} contatos válidos encontrados`
      });
    },
    onError: (error: any) => {
      toast({ 
        title: "Erro ao processar planilha",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const sendMutation = useMutation({
    mutationFn: async (data: { contacts: Contact[]; message: string; delaySeconds: number }) => {
      return await apiRequest("POST", "/api/chat/bulk-message/send", data);
    },
    onSuccess: (data: any) => {
      setSendResult(data);
      setIsSending(true);
      refetchStatus();
      toast({ 
        title: "Disparo iniciado!",
        description: `Enviando para ${data.totalContacts} contatos. Tempo estimado: ${data.estimatedTimeMinutes} minutos`
      });
    },
    onError: (error: any) => {
      toast({ 
        title: "Erro ao iniciar disparo",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const pauseMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("POST", "/api/chat/bulk-message/pause", {});
    },
    onSuccess: () => {
      refetchStatus();
      toast({ title: "Disparo pausado" });
    },
    onError: (error: any) => {
      toast({ title: "Erro ao pausar", description: error.message, variant: "destructive" });
    }
  });

  const resumeMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("POST", "/api/chat/bulk-message/resume", {});
    },
    onSuccess: () => {
      refetchStatus();
      toast({ title: "Disparo retomado" });
    },
    onError: (error: any) => {
      toast({ title: "Erro ao retomar", description: error.message, variant: "destructive" });
    }
  });

  const stopMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("POST", "/api/chat/bulk-message/stop", {});
    },
    onSuccess: (data: any) => {
      setIsSending(false);
      toast({ 
        title: "Disparo encerrado",
        description: `${data.sentCount} mensagens enviadas (${data.successCount} sucesso, ${data.errorCount} erros)`
      });
    },
    onError: (error: any) => {
      toast({ title: "Erro ao encerrar", description: error.message, variant: "destructive" });
    }
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      parseMutation.mutate(file);
    }
  };

  const handleRemoveContact = (phone: string) => {
    setContacts(contacts.filter(c => c.phone !== phone));
  };

  const handleSend = () => {
    if (contacts.length === 0) {
      toast({ title: "Nenhum contato selecionado", variant: "destructive" });
      return;
    }
    if (!message.trim()) {
      toast({ title: "Digite uma mensagem", variant: "destructive" });
      return;
    }
    
    sendMutation.mutate({ contacts, message, delaySeconds });
  };

  const handleDownloadTemplate = () => {
    window.open("/api/chat/bulk-message/template", "_blank");
  };

  if (authLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-honest-orange" />
      </div>
    );
  }

  if (!user || !["admin", "coordinator", "telemarketing"].includes(user.role || "")) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Acesso não autorizado</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold mb-2 flex items-center gap-3" data-testid="page-title">
            <Send className="h-8 w-8 text-green-600" />
            Disparo em Massa
          </h1>
          <p className="text-muted-foreground">
            Envie mensagens WhatsApp para múltiplos contatos a partir de planilha Excel
          </p>
        </div>
        <BackToDashboardButton />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileSpreadsheet className="h-5 w-5" />
                1. Carregar Planilha
              </CardTitle>
              <CardDescription>
                Faça upload de uma planilha Excel (.xlsx) com os números de telefone
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Button 
                  variant="outline" 
                  onClick={handleDownloadTemplate}
                  data-testid="button-download-template"
                >
                  <Download className="h-4 w-4 mr-2" />
                  Baixar Modelo
                </Button>
              </div>

              <div 
                className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:border-green-500 hover:bg-green-50/50 transition-colors"
                onClick={() => fileInputRef.current?.click()}
                data-testid="upload-dropzone"
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept=".xlsx,.xls"
                  className="hidden"
                  data-testid="file-input"
                />
                {parseMutation.isPending ? (
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="h-10 w-10 text-green-600 animate-spin" />
                    <span className="text-muted-foreground">Processando planilha...</span>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    <Upload className="h-10 w-10 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      Clique ou arraste a planilha Excel aqui
                    </span>
                    <span className="text-sm text-muted-foreground">
                      Formatos aceitos: .xlsx, .xls
                    </span>
                  </div>
                )}
              </div>

              {parseStats && (
                <Alert>
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  <AlertDescription>
                    <strong>{parseStats.validContacts}</strong> contatos válidos de{" "}
                    <strong>{parseStats.totalRows}</strong> linhas na planilha
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                2. Contatos ({contacts.length})
              </CardTitle>
              <CardDescription>
                Lista de contatos que receberão a mensagem
              </CardDescription>
            </CardHeader>
            <CardContent>
              {contacts.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  Nenhum contato carregado. Faça upload de uma planilha acima.
                </div>
              ) : (
                <ScrollArea className="h-[300px]">
                  <div className="space-y-2">
                    {contacts.map((contact, idx) => (
                      <div 
                        key={contact.phone}
                        className="flex items-center justify-between p-2 bg-muted/50 rounded-lg"
                        data-testid={`contact-${idx}`}
                      >
                        <div className="flex items-center gap-3">
                          <Phone className="h-4 w-4 text-green-600" />
                          <div>
                            <span className="font-medium">{contact.name}</span>
                            <span className="text-muted-foreground ml-2 text-sm">
                              {contact.phone}
                            </span>
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveContact(contact.phone)}
                          data-testid={`remove-contact-${idx}`}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Send className="h-5 w-5" />
                3. Compor Mensagem
              </CardTitle>
              <CardDescription>
                Digite a mensagem que será enviada para todos os contatos
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Mensagem</Label>
                <Textarea
                  placeholder="Olá {{nome}}! Temos uma oferta especial para você..."
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={8}
                  className="resize-none"
                  data-testid="textarea-message"
                />
                <p className="text-sm text-muted-foreground">
                  Use <Badge variant="secondary">{"{{nome}}"}</Badge> para personalizar com o nome do contato
                </p>
              </div>

              <div className="space-y-2">
                <Label className="flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  Intervalo entre mensagens (segundos)
                </Label>
                <Input
                  type="number"
                  min={1}
                  max={30}
                  value={delaySeconds}
                  onChange={(e) => setDelaySeconds(Math.max(1, Math.min(30, parseInt(e.target.value) || 3)))}
                  className="w-32"
                  data-testid="input-delay"
                />
                <p className="text-sm text-muted-foreground">
                  Tempo de espera entre cada envio (1-30 segundos). Recomendado: 3-5 segundos.
                </p>
              </div>

              {contacts.length > 0 && message.trim() && (
                <Alert>
                  <Info className="h-4 w-4" />
                  <AlertDescription>
                    Tempo estimado: <strong>{Math.ceil((contacts.length * delaySeconds) / 60)} minutos</strong>{" "}
                    para {contacts.length} contatos
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Send className="h-5 w-5" />
                4. Enviar
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {isSending && jobStatus && (
                <div className="space-y-3">
                  <Alert className={jobStatus.status === 'paused' ? "bg-yellow-50 border-yellow-200" : "bg-green-50 border-green-200"}>
                    {jobStatus.status === 'paused' ? (
                      <Pause className="h-4 w-4 text-yellow-600" />
                    ) : (
                      <CheckCircle className="h-4 w-4 text-green-600" />
                    )}
                    <AlertDescription className={jobStatus.status === 'paused' ? "text-yellow-800" : "text-green-800"}>
                      {jobStatus.status === 'paused' ? 'Disparo pausado!' : 'Disparo em andamento!'}{' '}
                      <strong>{jobStatus.sentCount || 0}</strong> de <strong>{jobStatus.totalContacts}</strong> enviados
                      {jobStatus.errorCount ? ` (${jobStatus.errorCount} erros)` : ''}
                    </AlertDescription>
                  </Alert>
                  <Progress value={jobStatus.progress || 0} />
                  <p className="text-sm text-muted-foreground text-center">
                    {jobStatus.successCount || 0} sucesso • {jobStatus.errorCount || 0} erros
                  </p>
                  
                  <div className="flex gap-2">
                    {jobStatus.status === 'running' ? (
                      <Button
                        variant="outline"
                        className="flex-1"
                        onClick={() => pauseMutation.mutate()}
                        disabled={pauseMutation.isPending}
                      >
                        {pauseMutation.isPending ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Pause className="h-4 w-4 mr-2" />
                        )}
                        Pausar
                      </Button>
                    ) : jobStatus.status === 'paused' ? (
                      <Button
                        variant="outline"
                        className="flex-1 border-green-500 text-green-600 hover:bg-green-50"
                        onClick={() => resumeMutation.mutate()}
                        disabled={resumeMutation.isPending}
                      >
                        {resumeMutation.isPending ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Play className="h-4 w-4 mr-2" />
                        )}
                        Continuar
                      </Button>
                    ) : null}
                    
                    <Button
                      variant="destructive"
                      className="flex-1"
                      onClick={() => stopMutation.mutate()}
                      disabled={stopMutation.isPending}
                    >
                      {stopMutation.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Square className="h-4 w-4 mr-2" />
                      )}
                      Encerrar
                    </Button>
                  </div>
                </div>
              )}

              {!isSending && (
                <>
                  <Button
                    className="w-full"
                    size="lg"
                    onClick={handleSend}
                    disabled={contacts.length === 0 || !message.trim() || sendMutation.isPending}
                    data-testid="button-send"
                  >
                    {sendMutation.isPending ? (
                      <>
                        <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                        Iniciando disparo...
                      </>
                    ) : (
                      <>
                        <Send className="h-5 w-5 mr-2" />
                        Enviar para {contacts.length} contatos
                      </>
                    )}
                  </Button>
                  <p className="text-sm text-muted-foreground text-center">
                    As mensagens serão enviadas em segundo plano. Você pode fechar esta página.
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
