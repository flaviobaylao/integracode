import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Plus, User, Clock, History, Thermometer } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type LeadTemperature = 'cold' | 'warm' | 'hot' | 'very_hot';

const temperatureLabels: Record<LeadTemperature, string> = {
  cold: "Frio",
  warm: "Morno",
  hot: "Quente",
  very_hot: "Muito Quente"
};

const temperatureColors: Record<LeadTemperature, string> = {
  cold: "bg-blue-500",
  warm: "bg-yellow-500",
  hot: "bg-orange-500",
  very_hot: "bg-red-500"
};

interface LeadVisit {
  id: string;
  leadId: string;
  userId: string;
  userName: string;
  observation: string;
  temperature: LeadTemperature | null;
  visitDate: string;
  createdAt: string;
}

interface LeadVisitHistoryModalProps {
  open: boolean;
  onClose: () => void;
  leadId: string;
  leadName: string;
  currentTemperature?: LeadTemperature | null;
  onSuccess?: () => void;
}

export default function LeadVisitHistoryModal({ 
  open, 
  onClose, 
  leadId, 
  leadName,
  currentTemperature,
  onSuccess
}: LeadVisitHistoryModalProps) {
  const { toast } = useToast();
  const [isCreating, setIsCreating] = useState(false);
  const [observation, setObservation] = useState("");
  const [temperature, setTemperature] = useState<LeadTemperature | "">("");

  const { data: visits, isLoading } = useQuery<LeadVisit[]>({
    queryKey: [`/api/leads/${leadId}/visits`],
    enabled: open && !!leadId,
  });

  const createVisitMutation = useMutation({
    mutationFn: async (data: { observation: string; temperature?: LeadTemperature }) => {
      return await apiRequest('POST', `/api/leads/${leadId}/visits`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/leads/${leadId}/visits`] });
      queryClient.invalidateQueries({ queryKey: ['/api/leads'] });
      setIsCreating(false);
      setObservation("");
      setTemperature("");
      toast({
        title: "Sucesso",
        description: "Visita registrada com sucesso!",
      });
      onSuccess?.();
    },
    onError: (error: any) => {
      toast({
        title: "Erro",
        description: error.message || "Erro ao registrar visita",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = () => {
    if (!observation.trim()) {
      toast({
        title: "Erro",
        description: "Observação é obrigatória",
        variant: "destructive",
      });
      return;
    }

    createVisitMutation.mutate({
      observation: observation.trim(),
      temperature: temperature || undefined,
    });
  };

  const handleClose = () => {
    setIsCreating(false);
    setObservation("");
    setTemperature("");
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            Histórico de Visitas - {leadName}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-hidden flex flex-col">
          {currentTemperature && (
            <div className="flex items-center gap-2 mb-4 text-sm text-gray-600">
              <span>Temperatura atual:</span>
              <div className="flex items-center gap-1">
                <div className={`w-3 h-3 rounded-full ${temperatureColors[currentTemperature]}`} />
                <span className="font-medium">{temperatureLabels[currentTemperature]}</span>
              </div>
            </div>
          )}

          {!isCreating ? (
            <Button
              onClick={() => setIsCreating(true)}
              className="mb-4 w-full"
              variant="outline"
            >
              <Plus className="h-4 w-4 mr-2" />
              Registrar Nova Visita
            </Button>
          ) : (
            <Card className="mb-4 border-2 border-primary/20">
              <CardContent className="pt-4 space-y-4">
                <div>
                  <Label htmlFor="observation">Observação *</Label>
                  <Textarea
                    id="observation"
                    value={observation}
                    onChange={(e) => setObservation(e.target.value)}
                    placeholder="Descreva o que foi tratado na visita..."
                    rows={3}
                  />
                </div>

                <div>
                  <Label htmlFor="temperature">Atualizar Temperatura (opcional)</Label>
                  <Select
                    value={temperature}
                    onValueChange={(value: LeadTemperature | "") => setTemperature(value)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Manter temperatura atual" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cold">
                        <div className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full bg-blue-500" />
                          Frio
                        </div>
                      </SelectItem>
                      <SelectItem value="warm">
                        <div className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full bg-yellow-500" />
                          Morno
                        </div>
                      </SelectItem>
                      <SelectItem value="hot">
                        <div className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full bg-orange-500" />
                          Quente
                        </div>
                      </SelectItem>
                      <SelectItem value="very_hot">
                        <div className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full bg-red-500" />
                          Muito Quente
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setIsCreating(false);
                      setObservation("");
                      setTemperature("");
                    }}
                  >
                    Cancelar
                  </Button>
                  <Button
                    onClick={handleSubmit}
                    disabled={createVisitMutation.isPending}
                  >
                    {createVisitMutation.isPending ? "Salvando..." : "Salvar Visita"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <ScrollArea className="flex-1">
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-24 w-full" />
                ))}
              </div>
            ) : visits && visits.length > 0 ? (
              <div className="space-y-3 pr-4">
                {visits.map((visit) => (
                  <Card key={visit.id} className="border">
                    <CardContent className="pt-4">
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex items-center gap-2 text-sm text-gray-600">
                          <User className="h-4 w-4" />
                          <span className="font-medium">{visit.userName}</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-gray-500">
                          <Clock className="h-3 w-3" />
                          {format(new Date(visit.visitDate), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                        </div>
                      </div>
                      
                      {visit.temperature && (
                        <div className="flex items-center gap-1 mb-2 text-xs">
                          <Thermometer className="h-3 w-3 text-gray-500" />
                          <span className="text-gray-500">Temperatura alterada para:</span>
                          <div className={`w-2 h-2 rounded-full ${temperatureColors[visit.temperature]}`} />
                          <span className="font-medium">{temperatureLabels[visit.temperature]}</span>
                        </div>
                      )}
                      
                      <p className="text-sm whitespace-pre-wrap">{visit.observation}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-gray-500">
                <History className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p>Nenhuma visita registrada ainda</p>
                <p className="text-xs">Clique em "Registrar Nova Visita" para começar</p>
              </div>
            )}
          </ScrollArea>
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
