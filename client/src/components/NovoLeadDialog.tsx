import { useState } from "react";
import { useMutation } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Navigation, ChevronsUpDown, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { CIDADES_GO_DF } from "@/lib/cidadesGoDf";
import { useToast } from "@/hooks/use-toast";

// Formulário de "Novo Lead" reutilizado na Rota do Dia — mesmos campos e funcionalidade do
// formulário de "Novo Lead" da Gestão de Leads. Cria o lead (POST /api/leads) e devolve o lead
// criado via onCreated, para quem chamou já incluir na rota do dia.
export default function NovoLeadDialog(props: {
  open: boolean;
  onClose: () => void;
  defaultAssignedTo?: string;
  onCreated: (lead: any) => void;
}) {
  const { toast } = useToast();
  const [cityOpen, setCityOpen] = useState(false);
  const emptyForm = {
    fantasyName: "",
    city: "",
    latitude: "",
    longitude: "",
    contact: "",
    phone: "",
    observation: "",
    periodicity: "semanal",
  };
  const [formData, setFormData] = useState({ ...emptyForm });
  const resetForm = () => setFormData({ ...emptyForm });

  const handleCaptureLocation = () => {
    if (!navigator.geolocation) {
      toast({ title: "Erro", description: "Seu navegador não suporta geolocalização", variant: "destructive" });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const _lat = position.coords.latitude.toFixed(6);
        const _lng = position.coords.longitude.toFixed(6);
        setFormData((prev) => ({ ...prev, latitude: _lat, longitude: _lng }));
        toast({ title: "Sucesso", description: "Localização capturada!" });
        try {
          const res = await fetch(`/api/geocode/city?lat=${_lat}&lng=${_lng}`, { credentials: "include" });
          if (res.ok) {
            const j = await res.json();
            if (j?.city) {
              setFormData((prev) => ({ ...prev, city: String(j.city) }));
              toast({ title: "Município detectado", description: String(j.city) });
            }
          }
        } catch (_e) { /* cidade é complementar; segue sem travar */ }
      },
      () => {
        toast({ title: "Erro", description: "Não foi possível capturar a localização", variant: "destructive" });
      }
    );
  };

  const createMut = useMutation({
    mutationFn: async () => {
      const payload: any = { ...formData, status: "scheduled" };
      if (props.defaultAssignedTo) payload.assignedTo = props.defaultAssignedTo;
      return await apiRequest("POST", "/api/leads", payload);
    },
    onSuccess: (lead: any) => {
      toast({ title: "Lead criado", description: "Lead cadastrado com sucesso." });
      resetForm();
      props.onCreated(lead);
    },
    onError: (e: any) => {
      toast({ title: "Erro", description: e?.message || "Erro ao criar lead", variant: "destructive" });
    },
  });

  const handleSubmit = () => {
    if (!formData.fantasyName || !formData.latitude || !formData.longitude) {
      toast({ title: "Erro", description: "Nome fantasia, latitude e longitude são obrigatórios", variant: "destructive" });
      return;
    }
    createMut.mutate();
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!open) { resetForm(); props.onClose(); } }}>
      <DialogContent className="max-w-2xl z-[10000]">
        <DialogHeader>
          <DialogTitle>Novo Lead</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          <div>
            <Label htmlFor="nl-fantasyName">Nome Fantasia *</Label>
            <Input
              id="nl-fantasyName"
              value={formData.fantasyName}
              onChange={(e) => setFormData({ ...formData, fantasyName: e.target.value })}
              placeholder="Nome do lead"
              data-testid="nl-input-fantasy-name"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="nl-latitude">Latitude *</Label>
              <Input
                id="nl-latitude"
                type="number"
                step="0.000001"
                value={formData.latitude}
                onChange={(e) => setFormData({ ...formData, latitude: e.target.value })}
                onPaste={(e) => { const p = e.clipboardData.getData('text').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/); if (p) { e.preventDefault(); setFormData({ ...formData, latitude: p[1], longitude: p[2] }); } }}
                placeholder="-16.686891"
                data-testid="nl-input-latitude"
              />
            </div>
            <div>
              <Label htmlFor="nl-longitude">Longitude *</Label>
              <Input
                id="nl-longitude"
                type="number"
                step="0.000001"
                value={formData.longitude}
                onChange={(e) => setFormData({ ...formData, longitude: e.target.value })}
                onPaste={(e) => { const p = e.clipboardData.getData('text').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/); if (p) { e.preventDefault(); setFormData({ ...formData, latitude: p[1], longitude: p[2] }); } }}
                placeholder="-49.264794"
                data-testid="nl-input-longitude"
              />
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            onClick={handleCaptureLocation}
            className="w-full"
            data-testid="nl-button-capture-location"
          >
            <Navigation className="h-4 w-4 mr-2" />
            Capturar Localização Atual
          </Button>

          <div>
            <Label htmlFor="nl-city">Cidade</Label>
            <Popover open={cityOpen} onOpenChange={setCityOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  role="combobox"
                  aria-expanded={cityOpen}
                  className="w-full justify-between font-normal"
                  data-testid="nl-button-city"
                >
                  <span className={cn(!formData.city && "text-muted-foreground")}>
                    {formData.city || "Selecione o município..."}
                  </span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                <Command>
                  <CommandInput placeholder="Buscar município (GO + DF)..." />
                  <CommandList>
                    <CommandEmpty>Nenhum município encontrado.</CommandEmpty>
                    <CommandGroup>
                      {formData.city && (
                        <CommandItem
                          value="__limpar__"
                          onSelect={() => { setFormData({ ...formData, city: "" }); setCityOpen(false); }}
                          className="text-muted-foreground"
                        >
                          <X className="mr-2 h-4 w-4" />
                          Limpar seleção
                        </CommandItem>
                      )}
                      {CIDADES_GO_DF.map((cidade) => (
                        <CommandItem
                          key={cidade}
                          value={cidade}
                          onSelect={() => { setFormData({ ...formData, city: cidade }); setCityOpen(false); }}
                        >
                          <Check className={cn("mr-2 h-4 w-4", formData.city === cidade ? "opacity-100" : "opacity-0")} />
                          {cidade}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          <div>
            <Label htmlFor="nl-contact">Contato</Label>
            <Input
              id="nl-contact"
              value={formData.contact}
              onChange={(e) => setFormData({ ...formData, contact: e.target.value })}
              placeholder="Nome do contato"
              data-testid="nl-input-contact"
            />
          </div>

          <div>
            <Label htmlFor="nl-phone">Telefone</Label>
            <Input
              id="nl-phone"
              value={formData.phone}
              onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
              placeholder="(DDD) 9XXXX-XXXX"
              data-testid="nl-input-phone"
            />
          </div>

          <div>
            <Label htmlFor="nl-observation">Observação</Label>
            <Textarea
              id="nl-observation"
              value={formData.observation}
              onChange={(e) => setFormData({ ...formData, observation: e.target.value })}
              placeholder="Observações sobre o lead"
              rows={3}
              data-testid="nl-input-observation"
            />
          </div>

          <div>
            <Label htmlFor="nl-periodicity">Periodicidade</Label>
            <Select
              value={formData.periodicity || "semanal"}
              onValueChange={(value) => setFormData({ ...formData, periodicity: value })}
            >
              <SelectTrigger data-testid="nl-select-periodicity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="semanal">Semanal</SelectItem>
                <SelectItem value="quinzenal">Quinzenal</SelectItem>
                <SelectItem value="mensal">Mensal</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">Padrão: Semanal. Frequência de visita sugerida.</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { resetForm(); props.onClose(); }}>Cancelar</Button>
          <Button onClick={handleSubmit} disabled={createMut.isPending} data-testid="nl-button-save">
            {createMut.isPending ? "Salvando..." : "Salvar Lead"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
