import { useState } from "react";
import { useMutation } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Navigation } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// "Cadastrar Lead" — formulario rapido na Rota do Dia: Nome, Capturar localizacao (coordenada)
// e Observacao. Cria o lead (POST /api/leads) e devolve via onCreated para ja incluir na rota.
export default function NovoLeadDialog(props: {
  open: boolean;
  onClose: () => void;
  defaultAssignedTo?: string;
  onCreated: (lead: any) => void;
}) {
  const { toast } = useToast();
  const empty = { fantasyName: "", latitude: "", longitude: "", observation: "" };
  const [form, setForm] = useState({ ...empty });
  const reset = () => setForm({ ...empty });

  const capturar = () => {
    if (!navigator.geolocation) {
      toast({ title: "Erro", description: "Seu navegador não suporta geolocalização", variant: "destructive" });
      return;
    }
    const ok = (pos: GeolocationPosition) => {
      setForm((p) => ({ ...p, latitude: pos.coords.latitude.toFixed(6), longitude: pos.coords.longitude.toFixed(6) }));
      toast({ title: "Localização capturada", description: `Lat: ${pos.coords.latitude.toFixed(6)}, Lng: ${pos.coords.longitude.toFixed(6)}` });
    };
    const err = () => toast({ title: "Erro", description: "Não foi possível capturar a localização. Verifique o GPS.", variant: "destructive" });
    navigator.geolocation.getCurrentPosition(
      ok,
      () => navigator.geolocation.getCurrentPosition(ok, err, { enableHighAccuracy: false, timeout: 20000, maximumAge: 120000 }),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 }
    );
  };

  const createMut = useMutation({
    mutationFn: async () => {
      const payload: any = {
        fantasyName: form.fantasyName,
        latitude: form.latitude,
        longitude: form.longitude,
        observation: form.observation,
        status: "scheduled",
      };
      if (props.defaultAssignedTo) payload.assignedTo = props.defaultAssignedTo;
      return await apiRequest("POST", "/api/leads", payload);
    },
    onSuccess: (lead: any) => { toast({ title: "Lead cadastrado", description: "Lead criado com sucesso." }); reset(); props.onCreated(lead); },
    onError: (e: any) => toast({ title: "Erro", description: e?.message || "Erro ao cadastrar lead", variant: "destructive" }),
  });

  const submit = () => {
    if (!form.fantasyName || !form.latitude || !form.longitude) {
      toast({ title: "Campos obrigatórios", description: "Informe o nome e capture a localização.", variant: "destructive" });
      return;
    }
    createMut.mutate();
  };

  return (
    <Dialog open={props.open} onOpenChange={(o) => { if (!o) { reset(); props.onClose(); } }}>
      <DialogContent className="max-w-md z-[10000]">
        <DialogHeader>
          <DialogTitle>Cadastrar Lead</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="cl-nome">Nome Fantasia *</Label>
            <Input
              id="cl-nome"
              value={form.fantasyName}
              onChange={(e) => setForm({ ...form, fantasyName: e.target.value })}
              placeholder="Nome do lead"
              data-testid="cl-input-nome"
            />
          </div>

          <div className="rounded-md border p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium flex items-center gap-1"><Navigation className="w-4 h-4" /> Localização (obrigatória)</span>
              <Button type="button" size="sm" variant="outline" onClick={capturar} data-testid="cl-capturar">Capturar Localização</Button>
            </div>
            {form.latitude && form.longitude ? (
              <p className="text-xs text-green-700 dark:text-green-400">✓ Lat: {form.latitude} · Lng: {form.longitude}</p>
            ) : (
              <p className="text-xs text-muted-foreground">Toque em "Capturar Localização" para registrar o ponto do lead.</p>
            )}
          </div>

          <div>
            <Label htmlFor="cl-obs">Observação</Label>
            <Textarea
              id="cl-obs"
              value={form.observation}
              onChange={(e) => setForm({ ...form, observation: e.target.value })}
              placeholder="Observações sobre o lead"
              rows={3}
              data-testid="cl-input-obs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); props.onClose(); }}>Cancelar</Button>
          <Button onClick={submit} disabled={createMut.isPending} className="bg-green-600 hover:bg-green-700 text-white" data-testid="cl-salvar">
            {createMut.isPending ? "Salvando..." : "Cadastrar Lead"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
