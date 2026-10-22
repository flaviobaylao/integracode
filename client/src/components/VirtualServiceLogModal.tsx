import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Plus, Image, FileText, User, Clock, Trash2, Upload, X, DollarSign, ShoppingCart, Search, Calendar, Thermometer, ClipboardList } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ChangeRequestControl } from "@/components/change-request/ChangeRequestControl";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type ServiceType = 'debito_vencido' | 'venda' | 'nao_venda' | 'prospecao' | 'solicitacao_alteracao' | 'registro';

const serviceTypeLabels: Record<ServiceType, { label: string; color: string; icon: typeof DollarSign }> = {
  debito_vencido: { label: 'Débito Vencido', color: 'bg-red-100 text-red-700 border-red-200', icon: DollarSign },
  venda: { label: 'Venda', color: 'bg-green-100 text-green-700 border-green-200', icon: ShoppingCart },
  nao_venda: { label: 'Não Venda', color: 'bg-red-100 text-red-700 border-red-300', icon: X },
  prospecao: { label: 'Prospecção', color: 'bg-blue-100 text-blue-700 border-blue-200', icon: Search },
  solicitacao_alteracao: { label: 'Solicitação de Alteração', color: 'bg-indigo-100 text-indigo-700 border-indigo-300', icon: ClipboardList },
  registro: { label: 'Registro', color: 'bg-slate-100 text-slate-700 border-slate-300', icon: FileText },
};

// Flags de tipo escolhíveis no atendimento de CLIENTE (virtual). 'venda' fica no fluxo de venda.
// (out/2026) "Solicitação de Alteração" saiu daqui — o botão Solicitar Alteração fica abaixo das notas.
const CUSTOMER_SERVICE_TYPES: ServiceType[] = ['nao_venda', 'registro'];

// 🚫 Motivos da Não Venda — mesmas regras do formulário presencial (NoSaleModal).
// Foto obrigatória só para cliente PRESENCIAL; virtual = opcional.
const NAO_VENDA_MOTIVOS: Array<{ value: string; label: string; foto?: boolean; obs?: boolean }> = [
  { value: "com_estoque", label: "Cliente com Estoque", foto: true },
  { value: "com_debito", label: "Cliente com Débito", obs: true },
  { value: "estab_fechado", label: "Estabelecimento Fechado", foto: true },
  { value: "sem_retorno", label: "Sem retorno do cliente" },
  { value: "outro_motivo", label: "Outro Motivo", obs: true },
];

interface VirtualServiceLog {
  id: string;
  customer_id: string;
  attendant_id: string;
  attendant_name: string;
  attendance_date: string;
  service_type?: ServiceType | null;
  notes: string | null;
  images: string[];
  created_at: string;
  updated_at: string;
}

type EntityType = 'customer' | 'lead';

interface VirtualServiceLogModalProps {
  open: boolean;
  onClose: () => void;
  customerId: string;
  customerName: string;
  defaultServiceType?: ServiceType;
  entityType?: EntityType;
  onSuccess?: () => void;
  serviceDate?: string;
}

export default function VirtualServiceLogModal({ 
  open, 
  onClose, 
  customerId, 
  customerName,
  defaultServiceType,
  entityType = 'customer',
  onSuccess,
  serviceDate
}: VirtualServiceLogModalProps) {
  const { toast } = useToast();
  // (out/2026) Abre DIRETO no formulário de registro (sem a tela intermediária).
  const [isCreating, setIsCreating] = useState(true);
  const [notes, setNotes] = useState("");
  const [images, setImages] = useState<string[]>([]);
  // Cliente: o tipo de atendimento é de escolha OBRIGATÓRIA (nada pré-selecionado, salvo um
  // default explícito válido vindo da tela que abriu). Lead: só existe "Prospecção".
  const effectiveDefaultType: ServiceType | null = entityType === 'lead'
    ? 'prospecao'
    : (defaultServiceType && CUSTOMER_SERVICE_TYPES.includes(defaultServiceType) ? defaultServiceType : null);
  const [serviceType, setServiceType] = useState<ServiceType | null>(effectiveDefaultType);
  const [noSaleReason, setNoSaleReason] = useState<string>("");
  const [uploadingImage, setUploadingImage] = useState(false);
  const [nextContactDate, setNextContactDate] = useState<string>("");
  const [temperature, setTemperature] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loadingConversa, setLoadingConversa] = useState(false);

  // Reset serviceType when modal opens with a new defaultServiceType
  useEffect(() => {
    if (open) {
      const newDefault: ServiceType | null = entityType === 'lead'
        ? 'prospecao'
        : (defaultServiceType && CUSTOMER_SERVICE_TYPES.includes(defaultServiceType) ? defaultServiceType : null);
      setServiceType(newDefault);
      setNoSaleReason("");
      setIsCreating(true);
    }
  }, [open, defaultServiceType, entityType]);

  // Cliente presencial x virtual (define se a foto da Não Venda é obrigatória).
  const { data: customerInfo } = useQuery<any>({
    queryKey: [`/api/customers/${customerId}`],
    enabled: open && entityType === 'customer' && !!customerId,
  });
  const ehVirtual = customerInfo?.virtualService === true;
  const motivoNV = serviceType === 'nao_venda' ? NAO_VENDA_MOTIVOS.find((m) => m.value === noSaleReason) : undefined;
  const nvExigeFoto = !!motivoNV?.foto && !ehVirtual;
  const nvExigeObs = !!motivoNV?.obs;

  const { data: logs, isLoading } = useQuery<VirtualServiceLog[]>({
    queryKey: [`/api/service-logs/${entityType}/${customerId}`],
    enabled: open && !!customerId,
  });

  const createLogMutation = useMutation({
    mutationFn: async (data: { notes: string; images: string[]; serviceType: ServiceType; noSaleReason?: string; nextContactDate?: string; temperature?: string; attendanceDate?: string }) => {
      return await apiRequest("POST", `/api/service-logs/${entityType}/${customerId}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/service-logs/${entityType}/${customerId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/service-logs/last/customer"] });
      queryClient.invalidateQueries({ queryKey: ["/api/service-logs/last/lead"] });
      queryClient.invalidateQueries({ queryKey: ["/api/service-logs/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/service-logs/count/customer"] });
      toast({
        title: "Atendimento registrado",
        description: "O registro foi salvo com sucesso.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
      onSuccess?.();
      // Registrou → fecha e volta para a tela anterior.
      handleClose();
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao registrar",
        description: error.message || "Não foi possível registrar o atendimento.",
        variant: "destructive",
      });
    },
  });

  const deleteLogMutation = useMutation({
    mutationFn: async (logId: string) => {
      return await apiRequest("DELETE", `/api/service-logs/${logId}`);
    },
    onSuccess: () => {
      // Invalidate specific customer logs
      queryClient.invalidateQueries({ queryKey: [`/api/service-logs/${entityType}/${customerId}`] });
      // Invalidate the batch query used by Active Customers list
      queryClient.invalidateQueries({ queryKey: ["/api/service-logs/last/customer"] });
      queryClient.invalidateQueries({ queryKey: ["/api/service-logs/last/lead"] });
      queryClient.invalidateQueries({ queryKey: ["/api/service-logs/stats"] });
      toast({
        title: "Registro excluído",
        description: "O registro foi excluído com sucesso.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Erro ao excluir",
        description: error.message || "Não foi possível excluir o registro.",
        variant: "destructive",
      });
    },
  });

  // Comprime a imagem no cliente e a guarda como data URL (base64) embutida no
  // próprio registro (campo images). Não há object storage externo disponível
  // neste ambiente (Railway), então evitamos o upload externo. Redimensiona p/ 1280px
  // e usa JPEG q=0.72 com fundo branco, mantendo o tamanho enxuto no banco.
  const fileToCompressedDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Não foi possível ler o arquivo"));
      reader.onload = () => {
        const el = document.createElement("img");
        el.onerror = () => reject(new Error("Arquivo de imagem inválido"));
        el.onload = () => {
          const maxDim = 1280;
          let w = el.naturalWidth || el.width;
          let h = el.naturalHeight || el.height;
          if (!w || !h) return reject(new Error("Dimensões de imagem inválidas"));
          if (w > maxDim || h > maxDim) {
            const scale = Math.min(maxDim / w, maxDim / h);
            w = Math.round(w * scale);
            h = Math.round(h * scale);
          }
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) return reject(new Error("Canvas não suportado"));
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(el, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.72));
        };
        el.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });

  const uploadImageFile = async (file: File) => {
    const dataUrl = await fileToCompressedDataUrl(file);
    setImages(prev => [...prev, dataUrl]);
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploadingImage(true);
    
    try {
      for (const file of Array.from(files)) {
        await uploadImageFile(file);
      }
      toast({
        title: "Imagem(ns) enviada(s)",
        description: "As imagens foram anexadas ao registro.",
      });
    } catch (error: any) {
      toast({
        title: "Erro ao enviar imagem",
        description: error.message || "Não foi possível enviar a imagem.",
        variant: "destructive",
      });
    } finally {
      setUploadingImage(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          imageFiles.push(file);
        }
      }
    }

    if (imageFiles.length === 0) return;

    e.preventDefault();
    setUploadingImage(true);

    try {
      for (const file of imageFiles) {
        await uploadImageFile(file);
      }
      toast({
        title: "Imagem colada",
        description: `${imageFiles.length} imagem(ns) anexada(s) com sucesso.`,
      });
    } catch (error: any) {
      toast({
        title: "Erro ao colar imagem",
        description: error.message || "Não foi possível processar a imagem colada.",
        variant: "destructive",
      });
    } finally {
      setUploadingImage(false);
    }
  };

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
  };

  const anexarConversaCentral = async () => {
    if (entityType !== 'customer') {
      toast({ title: "Indisponível", description: "Disponível apenas para clientes.", variant: "destructive" });
      return;
    }
    setLoadingConversa(true);
    try {
      const _dateQ = serviceDate ? `?date=${encodeURIComponent(serviceDate)}` : '';
      const data: any = await apiRequest("GET", `/api/chat/conversation-for-customer/${customerId}${_dateQ}`);
      if (!data?.found || !Array.isArray(data.messages) || data.messages.length === 0) {
        toast({ title: "Sem conversa", description: data?.reason || "Não há conversa vinculada na Central.", variant: "destructive" });
        return;
      }
      const linhas = data.messages.map((m: any) => {
        const quem = m.senderType === 'customer' ? 'Cliente' : (m.senderType === 'agent' ? 'Atendente' : 'Sistema');
        let hora = '';
        try { hora = format(new Date(m.createdAt), "dd/MM HH:mm", { locale: ptBR }); } catch {}
        return `[${hora}] ${quem}: ${String(m.content || '').trim()}`;
      }).join('\n');
      const capturadoEm = format(new Date(), "dd/MM/yyyy HH:mm", { locale: ptBR });
      const bloco = `----- Conversa da Central de Atendimento (${data.customerName || customerName})${data.date ? ' - dia ' + String(data.date).split('-').reverse().join('/') : ''} - capturada em ${capturadoEm} -----\n${linhas}\n----- fim da conversa (${data.messages.length} mensagens) -----`;
      setNotes(prev => (prev && prev.trim() ? prev + '\n\n' : '') + bloco);
      toast({ title: "Conversa anexada", description: `${data.messages.length} mensagens adicionadas às notas.` });
    } catch (e: any) {
      toast({ title: "Erro", description: e?.message || "Falha ao buscar a conversa.", variant: "destructive" });
    } finally {
      setLoadingConversa(false);
    }
  };

  const handleSubmit = () => {
    if (!serviceType) {
      toast({ title: "Tipo de atendimento obrigatório", description: "Escolha o tipo de atendimento.", variant: "destructive" });
      return;
    }
    if (serviceType === 'nao_venda' && entityType === 'customer') {
      if (!noSaleReason) {
        toast({ title: "Motivo obrigatório", description: "Selecione o motivo da Não Venda.", variant: "destructive" });
        return;
      }
      if (nvExigeObs && !notes.trim()) {
        toast({ title: "Observação obrigatória", description: `Para "${motivoNV?.label}" descreva o atendimento nas notas.`, variant: "destructive" });
        return;
      }
      if (nvExigeFoto && images.length === 0) {
        toast({ title: "Foto obrigatória", description: `Para "${motivoNV?.label}" (cliente presencial) anexe a foto.`, variant: "destructive" });
        return;
      }
      createLogMutation.mutate({ notes, images, serviceType, noSaleReason, attendanceDate: serviceDate || undefined });
      return;
    }
    if (!notes && images.length === 0) {
      toast({
        title: "Dados incompletos",
        description: "Adicione notas ou imagens ao atendimento.",
        variant: "destructive",
      });
      return;
    }
    createLogMutation.mutate({ 
      notes, 
      images, 
      serviceType,
      nextContactDate: nextContactDate || undefined,
      attendanceDate: serviceDate || undefined
    });
  };

  const handleClose = () => {
    setIsCreating(true);
    setNotes("");
    setImages([]);
    setNoSaleReason("");
    setServiceType(effectiveDefaultType);
    setNextContactDate("");
    setTemperature("");
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Atendimentos Virtuais - {customerName}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 flex flex-col gap-4">
          {!isCreating ? (
            <Button onClick={() => setIsCreating(true)} className="w-full">
              <Plus className="h-4 w-4 mr-2" />
              Registrar Novo Atendimento
            </Button>
          ) : (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Plus className="h-4 w-4" />
                  Novo Registro de Atendimento
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label>Tipo de Atendimento *</Label>
                <div className="mt-2 flex gap-2 flex-wrap">
                  {entityType === 'customer' ? (
                    CUSTOMER_SERVICE_TYPES.map((type) => {
                      const config = serviceTypeLabels[type];
                      const Icon = config.icon;
                      const isSelected = serviceType === type;
                      return (
                        <button
                          key={type}
                          type="button"
                          onClick={() => { setServiceType(type); if (type !== 'nao_venda') setNoSaleReason(""); }}
                          className={`flex items-center gap-2 px-4 py-2 rounded-lg border-2 transition-all ${
                            isSelected
                              ? `${config.color} border-current font-medium shadow-sm`
                              : 'border-gray-200 hover:border-gray-300 text-gray-600 hover:text-gray-800'
                          }`}
                          data-testid={`vsl-type-${type}`}
                        >
                          <Icon className="h-4 w-4" />
                          {config.label}
                        </button>
                      );
                    })
                  ) : (
                    (Object.keys(serviceTypeLabels) as ServiceType[])
                      .filter((type) => type === 'prospecao')
                      .map((type) => {
                        const config = serviceTypeLabels[type];
                        const Icon = config.icon;
                        const isSelected = serviceType === type;
                        return (
                          <button
                            key={type}
                            type="button"
                            onClick={() => setServiceType(type)}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg border-2 transition-all ${
                              isSelected
                                ? `${config.color} border-current font-medium shadow-sm`
                                : 'border-gray-200 hover:border-gray-300 text-gray-600 hover:text-gray-800'
                            }`}
                          >
                            <Icon className="h-4 w-4" />
                            {config.label}
                          </button>
                        );
                      })
                  )}
                </div>
                {entityType === 'customer' && !serviceType && (
                  <p className="text-xs text-red-600 mt-1">Escolha o tipo de atendimento.</p>
                )}
                </div>

                {entityType === 'customer' && serviceType === 'nao_venda' && (
                  <div className="space-y-2">
                    <Label>Motivo da Não Venda *</Label>
                    {/* Lista NATIVA (abre o seletor do próprio celular — mais confiável no mobile). */}
                    <select
                      value={noSaleReason}
                      onChange={(e) => setNoSaleReason(e.target.value)}
                      className={`w-full h-10 rounded-md border bg-background px-3 text-sm ${!noSaleReason ? 'border-red-400 text-muted-foreground' : 'border-input'}`}
                      data-testid="vsl-select-no-sale-reason"
                    >
                      <option value="">Selecione o motivo</option>
                      {NAO_VENDA_MOTIVOS.map((m) => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                      ))}
                    </select>
                    {!noSaleReason && (
                      <p className="text-xs text-red-600">Selecione o motivo da Não Venda para salvar.</p>
                    )}
                    {motivoNV && (
                      <p className="text-xs rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-300 px-2 py-1">
                        Motivo selecionado: {motivoNV.label}
                        {nvExigeFoto ? " — foto obrigatória" : nvExigeObs ? " — observação obrigatória" : ""}
                        {motivoNV.foto && ehVirtual ? " — cliente virtual: foto opcional" : ""}
                      </p>
                    )}
                  </div>
                )}
                
                <div>
                  <Label htmlFor="notes">Notas do Atendimento{nvExigeObs ? " *" : ""}</Label>
                  <Textarea
                    id="notes"
                    placeholder="Descreva o que foi tratado no atendimento... (Você pode colar imagens aqui com Ctrl+V)"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    onPaste={handlePaste}
                    rows={4}
                    className="mt-1"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Dica: Cole imagens diretamente com Ctrl+V ou Cmd+V
                  </p>
                </div>

                {entityType === 'customer' && (
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={anexarConversaCentral}
                        disabled={loadingConversa}
                        className="gap-2"
                      >
                        {loadingConversa ? (
                          <div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
                        ) : (
                          <FileText className="h-4 w-4" />
                        )}
                        Puxar Conversa do Umbler
                      </Button>
                      {/* 📋 Solicitar Alteração — abre a solicitação formal p/ este cliente. */}
                      <ChangeRequestControl
                        entityType="customer"
                        entityId={String(customerId)}
                        customerId={customerId}
                        entityName={customerName}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Anexa o histórico do chat do cliente (Central de Atendimento) nas notas acima.
                    </p>
                  </div>
                )}
                <div>
                  <Label>{nvExigeFoto ? "Foto (obrigatória)" : "Imagens"}</Label>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {images.map((img, index) => (
                      <div key={index} className="relative group">
                        <img
                          src={img}
                          alt={`Anexo ${index + 1}`}
                          className="w-20 h-20 object-cover rounded border"
                        />
                        <button
                          onClick={() => removeImage(index)}
                          className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploadingImage}
                      className="w-20 h-20 border-2 border-dashed rounded flex flex-col items-center justify-center text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                    >
                      {uploadingImage ? (
                        <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
                      ) : (
                        <>
                          <Upload className="h-6 w-6" />
                          <span className="text-xs mt-1">Adicionar</span>
                        </>
                      )}
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handleImageUpload}
                      className="hidden"
                    />
                  </div>
                </div>

                {entityType === 'lead' && (
                  <div>
                    <Label htmlFor="nextContactDate" className="flex items-center gap-2">
                      <Calendar className="h-4 w-4" />
                      Próximo Contato
                    </Label>
                    <Input
                      id="nextContactDate"
                      type="date"
                      value={nextContactDate}
                      onChange={(e) => setNextContactDate(e.target.value)}
                      className="mt-1 w-48"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Se não informado, será definido automaticamente para 7 dias após o atendimento
                    </p>
                  </div>
                )}

                <div className="flex gap-2 justify-end">
                  <Button variant="outline" onClick={handleClose}>
                    Cancelar
                  </Button>
                  <Button 
                    onClick={handleSubmit} 
                    disabled={createLogMutation.isPending}
                    data-testid="vsl-save"
                  >
                    {createLogMutation.isPending ? "Salvando..." : "Salvar Atendimento"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="flex-1 min-h-0">
            <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Histórico de Atendimentos
            </h3>
            <ScrollArea className="h-[300px] max-h-[50vh] pr-4">
              {isLoading ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-24 w-full" />
                  ))}
                </div>
              ) : logs && logs.length > 0 ? (
                <div className="space-y-4">
                  {logs.map((log) => (
                    <Card key={log.id} className="relative">
                      <CardContent className="pt-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                              {(() => {
                                const st = log.service_type || 'prospecao';
                                const config = serviceTypeLabels[st as ServiceType];
                                if (!config) return null;
                                const Icon = config.icon;
                                return (
                                  <Badge className={`text-xs ${config.color}`}>
                                    <Icon className="h-3 w-3 mr-1" />
                                    {config.label}
                                  </Badge>
                                );
                              })()}
                              <Badge variant="outline" className="text-xs">
                                <User className="h-3 w-3 mr-1" />
                                {log.attendant_name}
                              </Badge>
                              <span className="text-xs text-muted-foreground">
                                {format(new Date(log.attendance_date), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                              </span>
                            </div>
                            
                            {log.notes && (
                              <p className="text-sm whitespace-pre-wrap">{log.notes}</p>
                            )}
                            
                            {log.images && log.images.length > 0 && (
                              <div className="mt-2 flex flex-wrap gap-2">
                                {log.images.map((img, index) => (
                                  <a
                                    key={index}
                                    href={img}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="block"
                                  >
                                    <img
                                      src={img}
                                      alt={`Anexo ${index + 1}`}
                                      className="w-16 h-16 object-cover rounded border hover:opacity-80 transition-opacity"
                                    />
                                  </a>
                                ))}
                              </div>
                            )}
                          </div>
                          
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              if (confirm("Deseja excluir este registro?")) {
                                deleteLogMutation.mutate(log.id);
                              }
                            }}
                            className="text-red-500 hover:text-red-700"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <FileText className="h-12 w-12 mx-auto mb-2 opacity-50" />
                  <p>Nenhum atendimento registrado</p>
                </div>
              )}
            </ScrollArea>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
