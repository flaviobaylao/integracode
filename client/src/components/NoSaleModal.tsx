import { useState } from "react";
import { useMutation, useQueryClient } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { XCircle, AlertTriangle, Camera } from "lucide-react";
import { ChangeRequestControl } from "@/components/change-request/ChangeRequestControl";
import type { SalesCardWithRelations } from "@shared/schema";

interface NoSaleModalProps {
  isOpen: boolean;
  onClose: () => void;
  card: SalesCardWithRelations | null;
}

// 🚫 Motivos da Não Venda (out/2026) e o que cada um exige.
// Toda Não Venda gera notificação no Inbox do admin (servidor).
const MOTIVOS: Array<{ value: string; label: string; foto?: boolean; obs?: boolean }> = [
  { value: "com_estoque", label: "Cliente com Estoque", foto: true },
  { value: "com_debito", label: "Cliente com Débito", obs: true },
  { value: "estab_fechado", label: "Estabelecimento Fechado", foto: true },
  { value: "sem_retorno", label: "Sem retorno do cliente" },
  { value: "outro_motivo", label: "Outro Motivo", obs: true },
];

export default function NoSaleModal({ isOpen, onClose, card }: NoSaleModalProps) {
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const motivo = MOTIVOS.find((m) => m.value === reason);
  // Foto obrigatória só para cliente PRESENCIAL; no atendimento VIRTUAL a foto é opcional.
  const ehVirtual = (card as any)?.customer?.virtualService === true;
  // 📷 Se a foto da visita JÁ foi tirada no check-in de HOJE, não se pede a mesma foto outra vez.
  // Cards permanentes são reaproveitados e guardam o último check-in, por isso o recorte pelo dia
  // em Brasília: só a foto de hoje representa esta visita.
  const mesmoDiaBR = (t: any) => {
    if (!t) return false;
    try {
      const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
      return f.format(new Date(t)) === f.format(new Date());
    } catch { return false; }
  };
  const temFotoCheckIn = !!String((card as any)?.checkInPhotoUrl || '').trim() && mesmoDiaBR((card as any)?.checkInTime);
  const exigeFoto = !!motivo?.foto && !ehVirtual && !temFotoCheckIn;
  const exigeObs = !!motivo?.obs;
  const podeConfirmar = !!reason && (!exigeFoto || !!photo) && (!exigeObs || !!notes.trim());

  const resetForm = () => {
    setReason("");
    setNotes("");
    setPhoto(null);
    setPhotoPreview(null);
    setIsSubmitting(false);
  };

  const fechar = () => { onClose(); resetForm(); };

  const updateCardMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      await apiRequest("PUT", `/api/sales-cards/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sales-cards"] });
      // Não Venda também conta como registro de atendimento virtual (Rota do Dia)
      queryClient.invalidateQueries({ queryKey: ["/api/service-logs/count/customer"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daily-routes"] });
      toast({ title: "Não Venda registrada", description: "O admin foi notificado no Inbox." });
      fechar();
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error?.message || "Falha ao registrar a Não Venda.", variant: "destructive" });
    },
  });

  // Envia a foto (mesmo endpoint de imagens do app) e devolve a URL salva.
  const enviarFoto = async (file: File): Promise<string> => {
    const fd = new FormData();
    fd.append("image", file);
    const resp = await fetch("/api/upload-image", { method: "POST", body: fd, credentials: "include" });
    const j: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !j?.url) throw new Error(j?.message || "Falha ao enviar a foto.");
    return String(j.url);
  };

  const handleSubmit = async () => {
    if (!card) return;
    if (!reason) {
      toast({ title: "Motivo obrigatório", description: "Selecione o motivo da não venda.", variant: "destructive" });
      return;
    }
    if (exigeFoto && !photo) {
      toast({ title: "Foto obrigatória", description: `Para "${motivo?.label}" é obrigatório anexar a foto.`, variant: "destructive" });
      return;
    }
    if (exigeObs && !notes.trim()) {
      toast({ title: "Observação obrigatória", description: `Para "${motivo?.label}" preencha as Observações Adicionais.`, variant: "destructive" });
      return;
    }
    setIsSubmitting(true);
    try {
      let noSalePhotoUrl: string | null = null;
      if (photo) noSalePhotoUrl = await enviarFoto(photo);
      await updateCardMutation.mutateAsync({
        id: card.id,
        data: {
          status: "no_sale",
          noSaleReason: reason,
          notes: notes.trim(),
          completedDate: new Date(),
          noSalePhotoUrl,
        },
      });
    } catch (e: any) {
      toast({ title: "Erro", description: e?.message || "Falha ao registrar a Não Venda.", variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!card) return null;
  const nomeCliente = card.customer?.fantasyName || card.customer?.name || "";

  return (
    <Dialog open={isOpen} onOpenChange={(o) => { if (!o) fechar(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <XCircle className="h-6 w-6 text-red-600" />
            <span>Venda Não Realizada</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <p className="text-sm font-medium flex items-center gap-2 text-gray-700 dark:text-gray-300">
            <AlertTriangle className="h-4 w-4 text-orange-500" /> Registrar Motivo da Não Venda
          </p>

          <div>
            <Label htmlFor="reason">Motivo da Não Venda *</Label>
            {/* Lista NATIVA (abre o seletor do próprio celular — mais confiável no mobile). */}
            <select
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className={`w-full h-10 rounded-md border bg-background px-3 text-sm mt-1 ${!reason ? 'border-red-400 text-muted-foreground' : 'border-input'}`}
              data-testid="select-no-sale-reason"
            >
              <option value="">Selecione o motivo</option>
              {MOTIVOS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          {motivo && (
            <div className="p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg">
              <p className="text-sm font-medium text-blue-800 dark:text-blue-300">
                Motivo selecionado: {motivo.label}
                {exigeFoto ? " — foto obrigatória" : exigeObs ? " — observação obrigatória" : ""}
                {motivo.foto && ehVirtual ? " — cliente virtual: foto opcional" : ""}
                {motivo.foto && !ehVirtual && temFotoCheckIn ? " — foto já registrada no check-in de hoje: opcional" : ""}
              </p>
            </div>
          )}

          {motivo?.foto && (
            <div className="rounded-md border p-3 space-y-2">
              <span className="text-sm font-medium flex items-center gap-1"><Camera className="w-4 h-4" /> Foto {exigeFoto ? "(obrigatória)" : "(opcional)"}</span>
              {!exigeFoto && temFotoCheckIn && !photoPreview && (
                <p className="text-xs text-green-700 dark:text-green-400">✓ A foto do check-in de hoje já foi registrada — só anexe outra se quiser.</p>
              )}
              {photoPreview ? (
                <div className="space-y-2">
                  <img src={photoPreview} alt="Foto da não venda" className="w-full max-h-48 object-contain rounded border" />
                  <Button type="button" size="sm" variant="outline" onClick={() => { setPhoto(null); setPhotoPreview(null); }} data-testid="button-no-sale-photo-remove">Trocar foto</Button>
                </div>
              ) : (
                <Input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    setPhoto(f);
                    const rd = new FileReader();
                    rd.onload = (ev) => setPhotoPreview(ev.target?.result as string);
                    rd.readAsDataURL(f);
                  }}
                  data-testid="input-no-sale-photo"
                />
              )}
            </div>
          )}

          <div>
            <Label htmlFor="notes">Observações Adicionais{exigeObs ? " *" : ""}</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Descreva detalhes sobre o motivo da não venda..."
              rows={4}
              className="resize-none"
              data-testid="textarea-no-sale-notes"
            />
            {exigeObs && !notes.trim() && (
              <p className="text-xs text-red-600 mt-1">Obrigatório para este motivo.</p>
            )}
          </div>
        </div>

        {/* Botões de Ação */}
        <div className="flex items-center justify-between gap-3 pt-6 border-t flex-wrap">
          {/* Solicitar Alteração: abre o card de escolha da alteração; ao enviar, volta para esta tela. */}
          <div>
            {card.customerId && (
              <ChangeRequestControl
                entityType="customer"
                entityId={String(card.customerId)}
                customerId={String(card.customerId)}
                entityName={nomeCliente}
                sellerId={card.sellerId ? String(card.sellerId) : null}
                className="justify-start"
              />
            )}
          </div>
          <div className="flex gap-3">
            <Button variant="outline" onClick={fechar} disabled={isSubmitting}>
              Cancelar
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="bg-red-500 hover:bg-red-600"
              data-testid="button-confirm-no-sale"
            >
              {isSubmitting ? (
                <>
                  <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full mr-2" />
                  Registrando...
                </>
              ) : (
                <>
                  <XCircle className="h-4 w-4 mr-2" />
                  Confirmar Não Venda
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
