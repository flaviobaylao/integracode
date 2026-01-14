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
import { Plus, Image, FileText, User, Clock, Trash2, Upload, X, DollarSign, ShoppingCart, Search } from "lucide-react";

type ServiceType = 'debito_vencido' | 'venda' | 'prospecao';

const serviceTypeLabels: Record<ServiceType, { label: string; color: string; icon: typeof DollarSign }> = {
  debito_vencido: { label: 'Débito Vencido', color: 'bg-red-100 text-red-700 border-red-200', icon: DollarSign },
  venda: { label: 'Venda', color: 'bg-green-100 text-green-700 border-green-200', icon: ShoppingCart },
  prospecao: { label: 'Prospecção', color: 'bg-blue-100 text-blue-700 border-blue-200', icon: Search },
};

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
}

export default function VirtualServiceLogModal({ 
  open, 
  onClose, 
  customerId, 
  customerName,
  defaultServiceType = 'prospecao',
  entityType = 'customer',
  onSuccess
}: VirtualServiceLogModalProps) {
  const { toast } = useToast();
  const [isCreating, setIsCreating] = useState(false);
  const [notes, setNotes] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [serviceType, setServiceType] = useState<ServiceType>(defaultServiceType);
  const [uploadingImage, setUploadingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset serviceType when modal opens with a new defaultServiceType
  useEffect(() => {
    if (open) {
      setServiceType(defaultServiceType);
    }
  }, [open, defaultServiceType]);

  const { data: logs, isLoading } = useQuery<VirtualServiceLog[]>({
    queryKey: [`/api/service-logs/${entityType}/${customerId}`],
    enabled: open && !!customerId,
  });

  const createLogMutation = useMutation({
    mutationFn: async (data: { notes: string; images: string[]; serviceType: ServiceType }) => {
      return await apiRequest("POST", `/api/service-logs/${entityType}/${customerId}`, data);
    },
    onSuccess: () => {
      // Invalidate specific customer logs
      queryClient.invalidateQueries({ queryKey: [`/api/service-logs/${entityType}/${customerId}`] });
      // Invalidate the batch query used by Active Customers list
      queryClient.invalidateQueries({ queryKey: ["/api/service-logs/last/customer"] });
      queryClient.invalidateQueries({ queryKey: ["/api/service-logs/last/lead"] });
      queryClient.invalidateQueries({ queryKey: ["/api/service-logs/stats"] });
      setNotes("");
      setImages([]);
      setServiceType(defaultServiceType);
      setIsCreating(false);
      toast({
        title: "Atendimento registrado",
        description: "O registro foi salvo com sucesso.",
      });
      onSuccess?.();
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

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploadingImage(true);
    
    try {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append("image", file);
        
        const response = await fetch("/api/upload-image", {
          method: "POST",
          body: formData,
          credentials: "include",
        });
        
        if (!response.ok) {
          throw new Error("Falha ao enviar imagem");
        }
        
        const result = await response.json();
        if (result.url) {
          setImages(prev => [...prev, result.url]);
        }
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

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = () => {
    if (!notes && images.length === 0) {
      toast({
        title: "Dados incompletos",
        description: "Adicione notas ou imagens ao atendimento.",
        variant: "destructive",
      });
      return;
    }
    createLogMutation.mutate({ notes, images, serviceType });
  };

  const handleClose = () => {
    setIsCreating(false);
    setNotes("");
    setImages([]);
    setServiceType(defaultServiceType);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Atendimentos Virtuais - {customerName}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-hidden flex flex-col gap-4">
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
                  <Label>Tipo de Atendimento</Label>
                  <div className="mt-2 flex gap-2 flex-wrap">
                    {(Object.keys(serviceTypeLabels) as ServiceType[]).map((type) => {
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
                    })}
                  </div>
                </div>
                
                <div>
                  <Label htmlFor="notes">Notas do Atendimento</Label>
                  <Textarea
                    id="notes"
                    placeholder="Descreva o que foi tratado no atendimento..."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={4}
                    className="mt-1"
                  />
                </div>

                <div>
                  <Label>Imagens</Label>
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

                <div className="flex gap-2 justify-end">
                  <Button variant="outline" onClick={() => setIsCreating(false)}>
                    Cancelar
                  </Button>
                  <Button 
                    onClick={handleSubmit} 
                    disabled={createLogMutation.isPending}
                  >
                    {createLogMutation.isPending ? "Salvando..." : "Salvar Atendimento"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="flex-1 overflow-hidden">
            <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Histórico de Atendimentos
            </h3>
            <ScrollArea className="h-[300px] pr-4">
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
