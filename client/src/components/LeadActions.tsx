import { useState } from "react";
import { useMutation } from "@/lib/queryClient";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckCircle, XCircle, Clock } from "lucide-react";

// Ações de um LEAD que está na Rota do Dia (paradas de lead da rota sequencial).
// Reaproveita os mesmos endpoints do painel "Retornos de Lead":
//  - Prorrogar:     POST /api/leads/:id/desfecho { acao: 'prorrogar', dias: 15 }
//  - Não converter: POST /api/leads/:id/desfecho { acao: 'nao_converter', motivo, observacao }
//  - Converter:     POST /api/leads/:id/convert-to-customer { ...dados }

const MOTIVOS: { value: string; label: string }[] = [
  { value: "preco", label: "Preço" },
  { value: "sem_interesse", label: "Sem interesse" },
  { value: "ja_tem_fornecedor", label: "Já tem fornecedor" },
  { value: "fechou", label: "Fechou / encerrou" },
  { value: "sem_perfil", label: "Sem perfil" },
  { value: "sem_contato", label: "Sem contato" },
  { value: "outro", label: "Outro" },
];

interface LeadActionsProps {
  leadId: string;
  leadName: string;
  sellerId?: string;
  date?: string;
  onDone?: () => void;
}

export default function LeadActions({ leadId, leadName, sellerId, date, onDone }: LeadActionsProps) {
  const { toast } = useToast();
  const [naoConverterOpen, setNaoConverterOpen] = useState(false);
  const [motivo, setMotivo] = useState<string>("");
  const [obs, setObs] = useState<string>("");
  const [converterOpen, setConverterOpen] = useState(false);
  const [cust, setCust] = useState<any>({});
  const [loadingLead, setLoadingLead] = useState(false);

  const invalidate = () => {
    if (sellerId && date) {
      queryClient.invalidateQueries({ queryKey: ["/api/daily-routes", sellerId, "date", date] });
    }
    queryClient.invalidateQueries({ queryKey: ["/api/leads/retornos"] });
    queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
    if (onDone) onDone();
  };

  const prorrogarMut = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/leads/${leadId}/desfecho`, { acao: "prorrogar", dias: 15 }),
    onSuccess: (r: any) => {
      toast({ title: "Retorno prorrogado", description: "Prorrogação registrada (única permitida)." });
      invalidate();
    },
    onError: (e: any) => toast({ title: "Não foi possível prorrogar", description: e?.message || "Erro", variant: "destructive" }),
  });

  const naoConverterMut = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/leads/${leadId}/desfecho`, { acao: "nao_converter", motivo, observacao: obs }),
    onSuccess: () => {
      toast({ title: "Lead finalizado", description: "Registrado como NÃO CONVERTIDO." });
      setNaoConverterOpen(false); setMotivo(""); setObs("");
      invalidate();
    },
    onError: (e: any) => toast({ title: "Erro", description: e?.message || "Falha ao finalizar", variant: "destructive" }),
  });

  const converterMut = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/leads/${leadId}/convert-to-customer`, {
      name: cust.name,
      customerType: cust.customerType || "pessoa_juridica",
      cpf: cust.cpf || null,
      cnpj: cust.cnpj || null,
      companyName: cust.companyName || null,
      phone: cust.phone,
      email: cust.email || null,
      address: cust.address,
      city: cust.city || null,
      state: cust.state || null,
      zipCode: cust.zipCode || null,
      neighborhood: cust.neighborhood || null,
      sellerId: cust.assignedTo || sellerId,
      weekdays: cust.weekdays || ["Seg"],
      visitPeriodicity: cust.visitPeriodicity || "semanal",
    }),
    onSuccess: () => {
      toast({ title: "Convertido!", description: "Lead virou cliente ativo." });
      setConverterOpen(false); setCust({});
      invalidate();
    },
    onError: (e: any) => toast({ title: "Erro ao converter", description: e?.message || "Verifique os dados", variant: "destructive" }),
  });

  // Abre o formulário de conversão, buscando os dados atuais do lead para pré-preencher.
  const openConverter = async () => {
    setConverterOpen(true);
    setLoadingLead(true);
    setCust({ name: leadName, customerType: "pessoa_juridica", phone: "", address: "", city: "", neighborhood: "", visitPeriodicity: "semanal" });
    try {
      const res = await fetch(`/api/leads/${leadId}`, { credentials: "include" });
      if (res.ok) {
        const l = await res.json();
        setCust((prev: any) => ({
          ...prev,
          name: l.fantasyName || prev.name,
          phone: l.phone || prev.phone,
          assignedTo: l.assignedTo || sellerId,
        }));
      }
    } catch {
      // silencioso — usuário preenche manualmente
    } finally {
      setLoadingLead(false);
    }
  };

  const prorrogar = () => {
    if (confirm("Prorrogar o retorno deste lead por até 15 dias? Só é permitido uma única vez.")) {
      prorrogarMut.mutate();
    }
  };

  return (
    <>
      <div className="flex flex-wrap gap-2 mt-2 pt-2 border-t border-dashed border-amber-300 dark:border-amber-700">
        <Button
          size="sm"
          className="bg-green-600 hover:bg-green-700 text-white h-8"
          onClick={(e) => { e.stopPropagation(); openConverter(); }}
          data-testid={`button-lead-converter-${leadId}`}
        >
          <CheckCircle className="w-4 h-4 mr-1" /> Converter
        </Button>
        <Button
          size="sm"
          variant="destructive"
          className="h-8"
          onClick={(e) => { e.stopPropagation(); setMotivo(""); setObs(""); setNaoConverterOpen(true); }}
          data-testid={`button-lead-naoconverter-${leadId}`}
        >
          <XCircle className="w-4 h-4 mr-1" /> Não converter
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-amber-400 text-amber-700 dark:text-amber-400 h-8"
          disabled={prorrogarMut.isPending}
          title="Prorrogar uma única vez (até +15 dias)"
          onClick={(e) => { e.stopPropagation(); prorrogar(); }}
          data-testid={`button-lead-prorrogar-${leadId}`}
        >
          <Clock className="w-4 h-4 mr-1" /> Prorrogar
        </Button>
      </div>

      {/* Dialog: Não converter */}
      <Dialog open={naoConverterOpen} onOpenChange={(o) => { if (!o) setNaoConverterOpen(false); }}>
        <DialogContent className="max-w-md" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Finalizar lead — Não convertido</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{leadName}</p>
            <div>
              <Label>Motivo da não-conversão *</Label>
              <Select value={motivo} onValueChange={setMotivo}>
                <SelectTrigger><SelectValue placeholder="Selecione o motivo" /></SelectTrigger>
                <SelectContent>
                  {MOTIVOS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Observação (opcional)</Label>
              <Input value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Detalhe, se quiser" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNaoConverterOpen(false)}>Cancelar</Button>
            <Button variant="destructive" disabled={!motivo || naoConverterMut.isPending} onClick={() => naoConverterMut.mutate()}>
              Confirmar não-conversão
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: Converter em cliente */}
      <Dialog open={converterOpen} onOpenChange={(o) => { if (!o) setConverterOpen(false); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Converter lead em cliente ativo</DialogTitle>
          </DialogHeader>
          {loadingLead && <p className="text-xs text-muted-foreground">Carregando dados do lead…</p>}
          <div className="space-y-3">
            <div>
              <Label>Nome / Razão social *</Label>
              <Input value={cust.name || ""} onChange={(e) => setCust({ ...cust, name: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Tipo *</Label>
                <Select value={cust.customerType || "pessoa_juridica"} onValueChange={(v) => setCust({ ...cust, customerType: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pessoa_juridica">Pessoa Jurídica (CNPJ)</SelectItem>
                    <SelectItem value="pessoa_fisica">Pessoa Física (CPF)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{(cust.customerType || "pessoa_juridica") === "pessoa_fisica" ? "CPF" : "CNPJ"}</Label>
                <Input
                  value={(cust.customerType === "pessoa_fisica" ? cust.cpf : cust.cnpj) || ""}
                  onChange={(e) => setCust({ ...cust, [cust.customerType === "pessoa_fisica" ? "cpf" : "cnpj"]: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Telefone *</Label>
                <Input value={cust.phone || ""} onChange={(e) => setCust({ ...cust, phone: e.target.value })} />
              </div>
              <div>
                <Label>Periodicidade</Label>
                <Select value={cust.visitPeriodicity || "semanal"} onValueChange={(v) => setCust({ ...cust, visitPeriodicity: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="semanal">Semanal</SelectItem>
                    <SelectItem value="quinzenal">Quinzenal</SelectItem>
                    <SelectItem value="mensal">Mensal</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Endereço *</Label>
              <Input value={cust.address || ""} onChange={(e) => setCust({ ...cust, address: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Cidade</Label>
                <Input value={cust.city || ""} onChange={(e) => setCust({ ...cust, city: e.target.value })} />
              </div>
              <div>
                <Label>Bairro</Label>
                <Input value={cust.neighborhood || ""} onChange={(e) => setCust({ ...cust, neighborhood: e.target.value })} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Dias de visita padrão: Segunda. Ajuste depois no cadastro do cliente, se necessário.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConverterOpen(false)}>Cancelar</Button>
            <Button
              className="bg-green-600 hover:bg-green-700 text-white"
              disabled={!cust.name || !cust.phone || !cust.address || converterMut.isPending}
              onClick={() => converterMut.mutate()}
            >
              Converter em cliente
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
