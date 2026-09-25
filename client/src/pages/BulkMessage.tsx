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
  AlertCircle, FileSpreadsheet, Clock, X, Info, Pause, Play, Square,
  Image as ImageIcon, UserCheck
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import BulkCustomerPicker, { type PickedContact } from "@/components/BulkCustomerPicker";

interface Contact {
  phone: string;
  name: string;
  valid: boolean;
  customerId?: string;
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
  const [contactSource, setContactSource] = useState<"base" | "planilha">("base");
  const [message, setMessage] = useState("");
  const [delaySeconds, setDelaySeconds] = useState(3);
  const [parseStats, setParseStats] = useState<{ totalRows: number; validContacts: number } | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ totalContacts: number; estimatedTimeMinutes: number } | null>(null);

  // Imagem opcional a enviar junto (URL pública gerada pelo servidor + preview local)
  const [imageUrl, setImageUrl] = useState<string>("");
  const [imagePreview, setImagePreview] = useState<string>("");
  const [imageName, setImageName] = useState<string>("");
  const [imageUploading, setImageUploading] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);

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
    mutationFn: async (data: { contacts: Contact[]; message: string; delaySeconds: number; imageUrl?: string }) => {
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

  const handleImageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast({ title: "Arquivo inválido", description: "Selecione uma imagem (JPG, PNG, WEBP...).", variant: "destructive" });
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      toast({ title: "Imagem muito grande", description: "O limite é 15 MB.", variant: "destructive" });
      return;
    }
    // Preview local imediato
    const reader = new FileReader();
    reader.onload = () => setImagePreview(String(reader.result || ""));
    reader.readAsDataURL(file);

    setImageUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/chat/bulk-message/upload-image", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || "Falha ao enviar imagem");
      }
      const data = await response.json();
      setImageUrl(data.url);
      setImageName(file.name);
      toast({ title: "Imagem anexada!", description: "Será enviada junto com a mensagem." });
    } catch (error: any) {
      setImagePreview("");
      toast({ title: "Erro ao anexar imagem", description: error.message, variant: "destructive" });
    } finally {
      setImageUploading(false);
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  };

  const handleRemoveImage = () => {
    setImageUrl("");
    setImagePreview("");
    setImageName("");
    if (imageInputRef.current) imageInputRef.current.value = "";
  };

  const handleRemoveContact = (phone: string) => {
    setContacts(contacts.filter(c => c.phone !== phone));
  };

  const handleSend = () => {
    if (contacts.length === 0) {
      toast({ title: "Nenhum contato selecionado", variant: "destructive" });
      return;
    }
    if (!message.trim() && !imageUrl) {
      toast({ title: "Digite uma mensagem ou anexe uma imagem", variant: "destructive" });
      return;
    }
    if (imageUploading) {
      toast({ title: "Aguarde o envio da imagem terminar", variant: "destructive" });
      return;
    }

    sendMutation.mutate({ contacts, message, delaySeconds, imageUrl: imageUrl || undefined });
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
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold mb-2 flex items-center gap-3" data-testid="page-title">
            <Send className="h-8 w-8 text-green-600" />
            Disparo em Massa
          </h1>
          <p className="text-muted-foreground">
            Envie mensagens (texto e/ou imagem) no WhatsApp para clientes filtrados da base ou a partir de planilha Excel
          </p>
        </div>
        <BackToDashboardButton />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            1. Escolher Contatos
          </CardTitle>
          <CardDescription>
            Selecione da base de Clientes Ativos (somente telefones confirmados pelo cliente) ou carregue uma planilha Excel
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="inline-flex rounded-lg border p-1 bg-muted/40">
            <button
              type="button"
              onClick={() => setContactSource("base")}
              className={`px-3 py-1.5 text-sm rounded-md flex items-center gap-2 ${contactSource === "base" ? "bg-white dark:bg-gray-800 shadow font-medium" : "text-muted-foreground"}`}
              data-testid="source-base"
            >
              <UserCheck className="h-4 w-4" /> Base de Clientes
            </button>
            <button
              type="button"
              onClick={() => setContactSource("planilha")}
              className={`px-3 py-1.5 text-sm rounded-md flex items-center gap-2 ${contactSource === "planilha" ? "bg-white dark:bg-gray-800 shadow font-medium" : "text-muted-foreground"}`}
              data-testid="source-planilha"
            >
              <FileSpreadsheet className="h-4 w-4" /> Planilha Excel
            </button>
          </div>

          {contactSource === "base" && (
            <BulkCustomerPicker value={contacts} onChange={setContacts} />
          )}

          {contactSource === "planilha" && (
            <div className="space-y-4">
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
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                2. Contatos ({contacts.length})
              </CardTitle>
              <CardDescription>
                {contactSource === "base"
                  ? "Clientes selecionados que receberão a mensagem"
                  : "Lista de contatos que receberão a mensagem"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {contacts.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  {contactSource === "base"
                    ? "Nenhum cliente selecionado. Use os filtros acima e marque os clientes."
                    : "Nenhum contato carregado. Faça upload de uma planilha acima."}
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
                Digite a mensagem e/ou anexe uma imagem que será enviada para todos os contatos
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>{imageUrl ? "Mensagem / Legenda da imagem" : "Mensagem"}</Label>
                <Textarea
                  placeholder="Olá {{nome}}! Temos uma oferta especial para você..."
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={imageUrl ? 5 : 8}
                  className="resize-none"
                  data-testid="textarea-message"
                />
                <p className="text-sm text-muted-foreground">
                  Use <Badge variant="secondary">{"{{nome}}"}</Badge> para personalizar com o nome do contato
                  {imageUrl ? " — o texto vai como legenda da imagem." : "."}
                </p>
              </div>

              {/* Anexo de imagem */}
              <div className="space-y-2">
                <Label className="flex items-center gap-2">
                  <ImageIcon className="h-4 w-4" />
                  Imagem (opcional)
                </Label>
                <input
                  type="file"
                  ref={imageInputRef}
                  onChange={handleImageChange}
                  accept="image/*"
                  className="hidden"
                  data-testid="image-input"
                />
                {imagePreview ? (
                  <div className="flex items-start gap-3 rounded-lg border p-3">
                    <img src={imagePreview} alt="Prévia" className="h-20 w-20 rounded-md object-cover border" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{imageName || "imagem"}</p>
                      <p className="text-xs text-muted-foreground">
                        {imageUploading ? "Enviando imagem..." : "Imagem pronta para envio"}
                      </p>
                      <div className="flex gap-2 mt-2">
                        <Button variant="outline" size="sm" onClick={() => imageInputRef.current?.click()} disabled={imageUploading}>
                          Trocar
                        </Button>
                        <Button variant="ghost" size="sm" onClick={handleRemoveImage} disabled={imageUploading}>
                          <X className="h-4 w-4 mr-1" /> Remover
                        </Button>
                      </div>
                    </div>
                    {imageUploading && <Loader2 className="h-5 w-5 animate-spin text-green-600" />}
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => imageInputRef.current?.click()}
                    disabled={imageUploading}
                    data-testid="button-attach-image"
                  >
                    {imageUploading ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Enviando...</>
                    ) : (
                      <><ImageIcon className="h-4 w-4 mr-2" /> Anexar imagem</>
                    )}
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">
                  JPG, PNG ou WEBP (até 15 MB). A imagem é enviada como foto do WhatsApp com o texto acima como legenda.
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

              {contacts.length > 0 && (message.trim() || imageUrl) && (
                <Alert>
                  <Info className="h-4 w-4" />
                  <AlertDescription>
                    Tempo estimado: <strong>{Math.ceil((contacts.length * delaySeconds) / 60)} minutos</strong>{" "}
                    para {contacts.length} contatos{imageUrl ? " (com imagem)" : ""}
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
                    disabled={contacts.length === 0 || (!message.trim() && !imageUrl) || imageUploading || sendMutation.isPending}
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
