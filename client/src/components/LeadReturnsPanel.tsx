import { useState } from "react";
import { useQuery, useMutation } from "@/lib/queryClient";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Target, Phone, CheckCircle, XCircle, Clock, AlertTriangle } from "lucide-react";

interface LeadReturn {
  id: string;
  fantasyName: string;
  contact: string | null;
  phone: string | null;
  temperature: string | null;
  status: string;
  assignedTo: string | null;
  postponementCount: number;
  returnDate: string | null;
  overdue: boolean;
}

const MOTIVOS: { value: string; label: string }[] = [
  { value: "preco", label: "Preço" },
  { value: "sem_interesse", label: "Sem interesse" },
  { value: "ja_tem_fornecedor", label: "Já tem fornecedor" },
  { value: "fechou", label: "Fechou / encerrou" },
  { value: "sem_perfil", label: "Sem perfil" },
  { value: "sem_contato", label: "Sem contato" },
  { value: "outro", label: "Outro" },
];

function fmtDate(d: string | null): string {
  if (!d) return "-";
  try {
    return new Date(String(d)).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  } catch {
    return String(d).slice(0, 10);
  }
}

export default function LeadReturnsPanel({ sellerId, date }: { sellerId: string; date: string }) {
  const { toast } = useToast();
  const [naoConverterLead, setNaoConverterLead] = useState<LeadReturn | null>(null);
  const [motivo, setMotivo] = useState<string>("");
  const [obs, setObs] = useState<string>("");
  const [converterLead, setConverterLead] = useState<LeadReturn | null>(null);
  const [cust, setCust] = useState<any>({});

  const { data, isLoading } = useQuery<{ hoje: LeadReturn[]; atrasados: LeadReturn[]; total: number; date: string }>({
    queryKey: ["/api/leads/retornos", sellerId, date],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (sellerId) params.append("sellerId", sellerId);
      if (date) params.append("date", date);
      const res = await fetch(`/api/leads/retornos?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Falha ao carregar retornos de lead");
      return res.json();
    },
    enabled: !!sellerId && !!date,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/leads/retornos", sellerId, date] });
    queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
  };

  const prorrogarMut = useMutation({
    mutationFn: async (leadId: string) => apiRequest("POST", `/api/leads/${leadId}/desfecho`, { acao: "prorrogar", dias: 15 }),
    onSuccess: (r: any) => {
      toast({ title: "Retorno prorrogado", description: `Nova visita em ${fmtDate(r?.returnDate)}. Prorrogação usada (única permitida).` });
      invalidate();
    },
    onError: (e: any) => toast({ title: "Não foi possível prorrogar", description: e?.message || "Erro", variant: "destructive" }),
  });

  const naoConverterMut = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/leads/${naoConverterLead!.id}/desfecho`, { acao: "nao_converter", motivo, observacao: obs }),
    onSuccess: () => {
      toast({ title: "Lead finalizado", description: "Registrado como NÃO CONVERTIDO." });
      setNaoConverterLead(null); setMotivo(""); setObs("");
      invalidate();
    },
    onError: (e: any) => toast({ title: "Erro", description: e?.message || "Falha ao finalizar", variant: "destructive" }),
  });

  const converterMut = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/leads/${converterLead!.id}/convert-to-customer`, {
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
      sellerId: converterLead!.assignedTo || sellerId,
      weekdays: cust.weekdays || ["Seg"],
      visitPeriodicity: cust.visitPeriodicity || "semanal",
    }),
    onSuccess: () => {
      toast({ title: "Convertido!", description: "Lead virou cliente ativo." });
      setConverterLead(null); setCust({});
      invalidate();
    },
    onError: (e: any) => toast({ title: "Erro ao converter", description: e?.message || "Verifique os dados", variant: "destructive" }),
  });

  const openConverter = (l: LeadReturn) => {
    setCust({ name: l.fantasyName, customerType: "pessoa_juridica", phone: l.phone || "", address: "", city: "", neighborhood: "", visitPeriodicity: "semanal" });
    setConverterLead(l);
  };

  const hoje = data?.hoje || [];
  const atrasados = data?.atrasados || [];
  if (isLoading || (hoje.length === 0 && atrasados.length === 0)) return null;

  const renderLead = (l: LeadReturn) => (
    <div key={l.id} className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-white dark:bg-gray-900 p-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Target className="w-4 h-4 text-amber-600 shrink-0" />
          <span className="font-semibold truncate">{l.fantasyName}</span>
          {l.overdue ? (
            <Badge className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200 shrink-0"><AlertTriangle className="w-3 h-3 mr-1" />Atrasado</Badge>
          ) : (
            <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 shrink-0"><Clock className="w-3 h-3 mr-1" />Retorno hoje</Badge>
          )}
        </div>
        <span className="text-xs text-muted-foreground shrink-0">Previsto: {fmtDate(l.returnDate)}</span>
      </div>
      {l.phone && (
        <a href={`https://wa.me/55${String(l.phone).replace(/\D/g, "")}`} target="_blank" rel="noreferrer" className="text-sm text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
          <Phone className="w-3 h-3" /> {l.phone}
        </a>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white" onClick={() => openConverter(l)} data-testid={`button-lead-converter-${l.id}`}>
          <CheckCircle className="w-4 h-4 mr-1" /> Converter em cliente
        </Button>
        <Button size="sm" variant="destructive" onClick={() => { setNaoConverterLead(l); setMotivo(""); setObs(""); }} data-testid={`button-lead-naoconverter-${l.id}`}>
          <XCircle className="w-4 h-4 mr-1" /> Não converter / Finalizar
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-amber-400 text-amber-700"
          disabled={l.postponementCount >= 1 || prorrogarMut.isPending}
          title={l.postponementCount >= 1 ? "Prorrogação já utilizada — finalize ou converta" : "Prorrogar uma única vez (até +15 dias)"}
          onClick={() => { if (confirm("Prorrogar o retorno deste lead por até 15 dias? Só é permitido uma única vez.")) prorrogarMut.mutate(l.id); }}
          data-testid={`button-lead-prorrogar-${l.id}`}
        >
          <Clock className="w-4 h-4 mr-1" /> {l.postponementCount >= 1 ? "Já prorrogado" : "Prorrogar (1x)"}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="my-6 border-t-2 border-amber-300 dark:border-amber-700 pt-4">
      <h3 className="text-lg font-bold text-amber-700 dark:text-amber-400 mb-3 flex items-center gap-2">
        <Target className="w-5 h-5" /> Retornos de Lead ({(hoje.length + atrasados.length)})
      </h3>
      <div className="space-y-3">
        {atrasados.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-red-700 uppercase">Atrasados — cobrar hoje ({atrasados.length})</p>
            {atrasados.map(renderLead)}
          </div>
        )}
        {hoje.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-blue-700 uppercase">Retorno de hoje ({hoje.length})</p>
            {hoje.map(renderLead)}
          </div>
        )}
      </div>

      {/* Dialog: Não converter */}
      <Dialog open={!!naoConverterLead} onOpenChange={(o) => { if (!o) setNaoConverterLead(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Finalizar lead — Não convertido</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{naoConverterLead?.fantasyName}</p>
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
            <Button variant="outline" onClick={() => setNaoConverterLead(null)}>Cancelar</Button>
            <Button variant="destructive" disabled={!motivo || naoConverterMut.isPending} onClick={() => naoConverterMut.mutate()}>
              Confirmar não-conversão
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: Converter em cliente */}
      <Dialog open={!!converterLead} onOpenChange={(o) => { if (!o) setConverterLead(null); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Converter lead em cliente ativo</DialogTitle>
          </DialogHeader>
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
            <Button variant="outline" onClick={() => setConverterLead(null)}>Cancelar</Button>
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
    </div>
  );
}
