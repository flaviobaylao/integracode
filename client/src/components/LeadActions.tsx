import { useState, useRef } from "react";
import { useMutation } from "@/lib/queryClient";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckCircle, XCircle, Clock, FileText, Phone } from "lucide-react";

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
  const [prorrogarOpen, setProrrogarOpen] = useState(false);
  const [novaData, setNovaData] = useState<string>("");
  const _pad = (n: number) => String(n).padStart(2, "0");
  const _toDay = (d: Date) => `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`;
  const prorrogarMin = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return _toDay(d); })();
  const prorrogarMax = (() => { const d = new Date(); d.setDate(d.getDate() + 15); return _toDay(d); })();
  // Registro de Atendimento (texto livre + ditado por voz via Web Speech API)
  const [atendOpen, setAtendOpen] = useState(false);
  const [atendTexto, setAtendTexto] = useState("");
  const [atendGravando, setAtendGravando] = useState(false);
  const atendRecRef = useRef<any>(null);
  const atendSpeechSupported = typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  const invalidate = () => {
    if (sellerId && date) {
      queryClient.invalidateQueries({ queryKey: ["/api/daily-routes", sellerId, "date", date] });
    }
    queryClient.invalidateQueries({ queryKey: ["/api/leads/retornos"] });
    queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
    if (onDone) onDone();
  };

  const prorrogarMut = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/leads/${leadId}/desfecho`, { acao: "prorrogar", data: novaData }),
    onSuccess: (r: any) => {
      toast({ title: "Retorno prorrogado", description: "Nova data de visita registrada." });
      setProrrogarOpen(false);
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

  const abrirProrrogar = () => {
    setNovaData(prorrogarMax);
    setProrrogarOpen(true);
  };

  const atendStart = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { toast({ title: "Ditado indisponível", description: "Use o Chrome no computador ou Android para gravar por voz.", variant: "destructive" }); return; }
    try {
      const rec = new SR();
      rec.lang = 'pt-BR'; rec.continuous = true; rec.interimResults = true;
      rec.onresult = (e: any) => {
        let add = '';
        for (let i = e.resultIndex; i < e.results.length; i++) { if (e.results[i].isFinal) add += e.results[i][0].transcript; }
        if (add.trim()) setAtendTexto((prev) => (prev ? prev.trim() + ' ' : '') + add.trim());
      };
      rec.onerror = () => setAtendGravando(false);
      rec.onend = () => setAtendGravando(false);
      atendRecRef.current = rec; setAtendGravando(true); rec.start();
    } catch (_e) { setAtendGravando(false); }
  };
  const atendStop = () => { try { atendRecRef.current && atendRecRef.current.stop(); } catch (_e) {} setAtendGravando(false); };
  const salvarAtendMut = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/leads/${leadId}/visits`, { observation: atendTexto.trim() }),
    onSuccess: () => { toast({ title: "Atendimento registrado", description: "Salvo no histórico do lead." }); atendStop(); setAtendOpen(false); setAtendTexto(""); invalidate(); },
    onError: (e: any) => toast({ title: "Erro ao registrar", description: e?.message || "Tente novamente.", variant: "destructive" }),
  });
  const atendDesfecho = (tipo: 'conv' | 'nao' | 'pro') => {
    const txt = atendTexto.trim();
    atendStop(); setAtendOpen(false); setAtendTexto("");
    if (tipo === 'nao') { setMotivo(""); setObs(txt); setNaoConverterOpen(true); return; }
    if (txt) { try { apiRequest("POST", `/api/leads/${leadId}/visits`, { observation: txt }); } catch (_e) {} }
    if (tipo === 'conv') openConverter(); else abrirProrrogar();
  };

  return (
    <>
      <div className="flex flex-wrap gap-2 mt-2 pt-2 border-t border-dashed border-amber-300 dark:border-amber-700">
        <Button
          size="sm"
          variant="outline"
          className="border-blue-400 text-blue-700 dark:text-blue-400 h-8"
          onClick={(e) => { e.stopPropagation(); setAtendTexto(""); setAtendGravando(false); setAtendOpen(true); }}
          title="Registro de Atendimento"
          data-testid={`button-lead-atendimento-${leadId}`}
        >
          <FileText className="w-4 h-4 mr-1" /> Registro
        </Button>
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
          title="Prorrogar (escolha livremente a data)"
          onClick={(e) => { e.stopPropagation(); abrirProrrogar(); }}
          data-testid={`button-lead-prorrogar-${leadId}`}
        >
          <Clock className="w-4 h-4 mr-1" /> Prorrogar
        </Button>
      </div>

      {/* Dialog: Prorrogar (escolher data, até +15 dias) */}
      <Dialog open={prorrogarOpen} onOpenChange={(o) => { if (!o) setProrrogarOpen(false); }}>
        <DialogContent className="max-w-sm" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Prorrogar retorno</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{leadName}</p>
            <div>
              <Label>Nova data da visita</Label>
              <Input type="date" value={novaData} onChange={(e) => setNovaData(e.target.value)} />
              <p className="text-[11px] text-muted-foreground mt-1">Escolha livremente a data da próxima visita.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setProrrogarOpen(false)}>Cancelar</Button>
            <Button
              className="bg-amber-500 hover:bg-amber-600 text-white"
              disabled={!novaData || prorrogarMut.isPending}
              onClick={() => prorrogarMut.mutate()}
            >
              Confirmar prorrogação
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      {/* Dialog: Registro de Atendimento (texto livre + ditado por voz) */}
      <Dialog open={atendOpen} onOpenChange={(o) => { if (!o) { atendStop(); setAtendOpen(false); } }}>
        <DialogContent className="max-w-lg" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Registro de Atendimento</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{leadName}</p>
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label htmlFor={`atend-${leadId}`}>Descrição do atendimento</Label>
                {atendSpeechSupported ? (
                  atendGravando ? (
                    <Button type="button" size="sm" variant="destructive" onClick={atendStop} data-testid={`button-lead-atend-stop-${leadId}`}>
                      <XCircle className="w-4 h-4 mr-1" /> Parar
                    </Button>
                  ) : (
                    <Button type="button" size="sm" variant="outline" className="border-blue-400 text-blue-700 dark:text-blue-400" onClick={atendStart} data-testid={`button-lead-atend-record-${leadId}`}>
                      <Phone className="w-4 h-4 mr-1" /> Gravar áudio
                    </Button>
                  )
                ) : (
                  <span className="text-[11px] text-muted-foreground">Ditado indisponível neste navegador</span>
                )}
              </div>
              <Textarea id={`atend-${leadId}`} rows={6} value={atendTexto} onChange={(e) => setAtendTexto(e.target.value)} placeholder="Digite o registro do atendimento ou use o botão Gravar áudio para ditar..." data-testid={`textarea-lead-atend-${leadId}`} />
              {atendGravando && <p className="text-[11px] text-red-600 mt-1 animate-pulse">● Gravando… fale e o texto aparece automaticamente.</p>}
            </div>
            <div className="flex justify-end">
              <Button onClick={() => { if (!atendTexto.trim()) { toast({ title: "Nada para salvar", description: "Escreva ou dite o atendimento.", variant: "destructive" }); return; } salvarAtendMut.mutate(); }} disabled={salvarAtendMut.isPending} data-testid={`button-lead-atend-save-${leadId}`}>
                Salvar registro
              </Button>
            </div>
            <div className="border-t pt-3">
              <p className="text-xs text-muted-foreground mb-2">Desfecho do lead</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white" onClick={() => atendDesfecho('conv')} data-testid={`button-lead-atend-converter-${leadId}`}>
                  <CheckCircle className="w-4 h-4 mr-1" /> Converter
                </Button>
                <Button size="sm" variant="destructive" onClick={() => atendDesfecho('nao')} data-testid={`button-lead-atend-naoconverter-${leadId}`}>
                  <XCircle className="w-4 h-4 mr-1" /> Não converter
                </Button>
                <Button size="sm" variant="outline" className="border-amber-400 text-amber-700 dark:text-amber-400" onClick={() => atendDesfecho('pro')} data-testid={`button-lead-atend-prorrogar-${leadId}`}>
                  <Clock className="w-4 h-4 mr-1" /> Prorrogar
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
