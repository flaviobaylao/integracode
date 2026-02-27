import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Pencil, Trash2, FileText, Copy } from "lucide-react";
import type { FiscalScenario } from "@shared/schema";

const OPERATION_TYPES = [
  { value: "venda_interna", label: "Venda Interna" },
  { value: "venda_interestadual", label: "Venda Interestadual" },
  { value: "amostra", label: "Remessa de Amostra" },
  { value: "bonificacao", label: "Bonificação" },
  { value: "troca", label: "Troca/Devolução" },
  { value: "transferencia", label: "Transferência" },
  { value: "consignacao", label: "Consignação" },
  { value: "industrializacao", label: "Industrialização" },
  { value: "exportacao", label: "Exportação" },
  { value: "outros", label: "Outros" },
];

const STATE_SCOPES = [
  { value: "interna", label: "Operação Interna (dentro do estado)" },
  { value: "interestadual", label: "Operação Interestadual" },
  { value: "exterior", label: "Operação com Exterior" },
];

const TAX_REGIMES = [
  { value: "simples_nacional", label: "Simples Nacional" },
  { value: "lucro_presumido", label: "Lucro Presumido" },
  { value: "lucro_real", label: "Lucro Real" },
];

const CSOSN_OPTIONS = [
  { value: "101", label: "101 - Tributada com permissão de crédito" },
  { value: "102", label: "102 - Tributada sem permissão de crédito" },
  { value: "103", label: "103 - Isenção do ICMS para faixa de receita bruta" },
  { value: "201", label: "201 - Tributada com permissão de crédito e com cobrança do ICMS por ST" },
  { value: "202", label: "202 - Tributada sem permissão de crédito e com cobrança do ICMS por ST" },
  { value: "203", label: "203 - Isenção do ICMS para faixa de receita bruta e com cobrança do ICMS por ST" },
  { value: "300", label: "300 - Imune" },
  { value: "400", label: "400 - Não tributada" },
  { value: "500", label: "500 - ICMS cobrado anteriormente por ST ou antecipação" },
  { value: "900", label: "900 - Outros" },
];

const CST_ICMS_OPTIONS = [
  { value: "00", label: "00 - Tributada integralmente" },
  { value: "10", label: "10 - Tributada e com cobrança do ICMS por ST" },
  { value: "20", label: "20 - Com redução de base de cálculo" },
  { value: "30", label: "30 - Isenta/não tributada e com cobrança do ICMS por ST" },
  { value: "40", label: "40 - Isenta" },
  { value: "41", label: "41 - Não tributada" },
  { value: "50", label: "50 - Suspensão" },
  { value: "51", label: "51 - Diferimento" },
  { value: "60", label: "60 - ICMS cobrado anteriormente por ST" },
  { value: "70", label: "70 - Com redução de BC e cobrança do ICMS por ST" },
  { value: "90", label: "90 - Outros" },
];

const CST_PIS_COFINS_OPTIONS = [
  { value: "01", label: "01 - Operação tributável (BC = valor da operação)" },
  { value: "02", label: "02 - Operação tributável (BC = valor da operação - alíquota diferenciada)" },
  { value: "04", label: "04 - Operação tributável (monofásica - revenda)" },
  { value: "05", label: "05 - Operação tributável por substituição tributária" },
  { value: "06", label: "06 - Operação tributável (alíquota zero)" },
  { value: "07", label: "07 - Operação isenta da contribuição" },
  { value: "08", label: "08 - Operação sem incidência da contribuição" },
  { value: "09", label: "09 - Operação com suspensão da contribuição" },
  { value: "49", label: "49 - Outras operações de saída" },
  { value: "99", label: "99 - Outras operações" },
];

const CST_IPI_OPTIONS = [
  { value: "50", label: "50 - Saída tributada" },
  { value: "51", label: "51 - Saída tributável com alíquota zero" },
  { value: "52", label: "52 - Saída isenta" },
  { value: "53", label: "53 - Saída não tributada" },
  { value: "54", label: "54 - Saída imune" },
  { value: "55", label: "55 - Saída com suspensão" },
  { value: "99", label: "99 - Outras saídas" },
];

const MODALIDADE_BC_ICMS = [
  { value: "0", label: "0 - Margem Valor Agregado (%)" },
  { value: "1", label: "1 - Pauta (Valor)" },
  { value: "2", label: "2 - Preço Tabelado Máx. (Valor)" },
  { value: "3", label: "3 - Valor da Operação" },
];

const COMMON_CFOPS = [
  { value: "5101", label: "5101 - Venda de produção do estabelecimento" },
  { value: "5102", label: "5102 - Venda de mercadoria adquirida" },
  { value: "5103", label: "5103 - Venda de produção, efetuada fora do estabelecimento" },
  { value: "5104", label: "5104 - Venda de mercadoria adquirida, efetuada fora do estabelecimento" },
  { value: "5401", label: "5401 - Venda com substituição tributária" },
  { value: "5403", label: "5403 - Venda em operação com mercadoria sujeita à ST" },
  { value: "5405", label: "5405 - Venda de mercadoria por contribuinte substituído" },
  { value: "5910", label: "5910 - Remessa em bonificação" },
  { value: "5911", label: "5911 - Remessa de amostra grátis" },
  { value: "5949", label: "5949 - Outra saída não especificada" },
  { value: "6101", label: "6101 - Venda de produção do estabelecimento (interestadual)" },
  { value: "6102", label: "6102 - Venda de mercadoria adquirida (interestadual)" },
  { value: "6401", label: "6401 - Venda com ST (interestadual)" },
  { value: "6403", label: "6403 - Venda com mercadoria sujeita à ST (interestadual)" },
  { value: "6910", label: "6910 - Remessa em bonificação (interestadual)" },
  { value: "6911", label: "6911 - Remessa de amostra grátis (interestadual)" },
  { value: "7101", label: "7101 - Venda de produção do estabelecimento (exportação)" },
];

interface FormData {
  name: string;
  operationType: string;
  stateScope: string;
  cfop: string;
  natureOfOperation: string;
  taxRegime: string;
  csosn: string;
  cstIcms: string;
  aliqIcms: string;
  modalidadeBcIcms: string;
  redBcIcms: string;
  cstIpi: string;
  aliqIpi: string;
  aliqIcmsInterestadual: string;
  aliqIcmsInterna: string;
  aliqFcp: string;
  modalidadeBcIcmsSt: string;
  mvaIcmsSt: string;
  redBcIcmsSt: string;
  aliqIcmsSt: string;
  aliqFcpSt: string;
  cstPis: string;
  aliqPis: string;
  cstCofins: string;
  aliqCofins: string;
  description: string;
  isActive: boolean;
}

const emptyForm: FormData = {
  name: "", operationType: "venda_interna", stateScope: "interna", cfop: "5101",
  natureOfOperation: "Venda de Mercadoria", taxRegime: "simples_nacional",
  csosn: "", cstIcms: "", aliqIcms: "", modalidadeBcIcms: "", redBcIcms: "",
  cstIpi: "", aliqIpi: "", aliqIcmsInterestadual: "", aliqIcmsInterna: "",
  aliqFcp: "", modalidadeBcIcmsSt: "", mvaIcmsSt: "", redBcIcmsSt: "",
  aliqIcmsSt: "", aliqFcpSt: "", cstPis: "", aliqPis: "", cstCofins: "",
  aliqCofins: "", description: "", isActive: true,
};

function TaxSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border rounded-lg p-4 space-y-3">
      <h4 className="text-sm font-semibold text-orange-600 uppercase tracking-wide">{title}</h4>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {children}
      </div>
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-gray-600">{label}</Label>
      {children}
    </div>
  );
}

export default function FiscalScenariosTab() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(emptyForm);
  const queryClient = useQueryClient();

  const { data: scenarios, isLoading } = useQuery<FiscalScenario[]>({
    queryKey: ['/api/fiscal-scenarios'],
  });

  const saveMutation = useMutation({
    mutationFn: async (data: FormData) => {
      const toNullable = (v: string) => v === '' ? null : v;
      const payload = {
        ...data,
        aliqIcms: toNullable(data.aliqIcms),
        aliqPis: toNullable(data.aliqPis),
        aliqCofins: toNullable(data.aliqCofins),
        aliqIpi: toNullable(data.aliqIpi),
        aliqIcmsInterestadual: toNullable(data.aliqIcmsInterestadual),
        aliqIcmsInterna: toNullable(data.aliqIcmsInterna),
        aliqFcp: toNullable(data.aliqFcp),
        mvaIcmsSt: toNullable(data.mvaIcmsSt),
        redBcIcms: toNullable(data.redBcIcms),
        redBcIcmsSt: toNullable(data.redBcIcmsSt),
        aliqIcmsSt: toNullable(data.aliqIcmsSt),
        aliqFcpSt: toNullable(data.aliqFcpSt),
        csosn: toNullable(data.csosn),
        cstIcms: toNullable(data.cstIcms),
        modalidadeBcIcms: toNullable(data.modalidadeBcIcms),
        cstIpi: toNullable(data.cstIpi),
        modalidadeBcIcmsSt: toNullable(data.modalidadeBcIcmsSt),
        cstPis: toNullable(data.cstPis),
        cstCofins: toNullable(data.cstCofins),
      };
      if (editingId) {
        return (await apiRequest('PUT', `/api/fiscal-scenarios/${editingId}`, payload)).json();
      }
      return (await apiRequest('POST', '/api/fiscal-scenarios', payload)).json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/fiscal-scenarios'] });
      setDialogOpen(false);
      setEditingId(null);
      setForm(emptyForm);
      toast({ title: editingId ? "Cenário atualizado" : "Cenário criado", description: "Cenário fiscal salvo com sucesso." });
    },
    onError: (err: any) => {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest('DELETE', `/api/fiscal-scenarios/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/fiscal-scenarios'] });
      toast({ title: "Cenário removido" });
    },
  });

  const handleEdit = (sc: FiscalScenario) => {
    setEditingId(sc.id);
    setForm({
      name: sc.name || "",
      operationType: sc.operationType || "venda_interna",
      stateScope: sc.stateScope || "interna",
      cfop: sc.cfop || "",
      natureOfOperation: sc.natureOfOperation || "",
      taxRegime: sc.taxRegime || "simples_nacional",
      csosn: sc.csosn || "",
      cstIcms: sc.cstIcms || "",
      aliqIcms: sc.aliqIcms || "",
      modalidadeBcIcms: sc.modalidadeBcIcms || "",
      redBcIcms: sc.redBcIcms || "",
      cstIpi: sc.cstIpi || "",
      aliqIpi: sc.aliqIpi || "",
      aliqIcmsInterestadual: sc.aliqIcmsInterestadual || "",
      aliqIcmsInterna: sc.aliqIcmsInterna || "",
      aliqFcp: sc.aliqFcp || "",
      modalidadeBcIcmsSt: sc.modalidadeBcIcmsSt || "",
      mvaIcmsSt: sc.mvaIcmsSt || "",
      redBcIcmsSt: sc.redBcIcmsSt || "",
      aliqIcmsSt: sc.aliqIcmsSt || "",
      aliqFcpSt: sc.aliqFcpSt || "",
      cstPis: sc.cstPis || "",
      aliqPis: sc.aliqPis || "",
      cstCofins: sc.cstCofins || "",
      aliqCofins: sc.aliqCofins || "",
      description: sc.description || "",
      isActive: sc.isActive ?? true,
    });
    setDialogOpen(true);
  };

  const handleDuplicate = (sc: FiscalScenario) => {
    handleEdit(sc);
    setEditingId(null);
    setForm(prev => ({ ...prev, name: `${prev.name} (Cópia)` }));
  };

  const handleNew = () => {
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const opLabel = (val: string) => OPERATION_TYPES.find(o => o.value === val)?.label || val;
  const scopeLabel = (val: string) => STATE_SCOPES.find(s => s.value === val)?.label?.split(" (")[0] || val;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Cenários Fiscais</h3>
          <p className="text-sm text-muted-foreground">Configure os parâmetros tributários para cada tipo de operação fiscal</p>
        </div>
        <Button onClick={handleNew} className="bg-orange-600 hover:bg-orange-700">
          <Plus className="h-4 w-4 mr-2" />Novo Cenário
        </Button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1,2,3].map(i => (
            <Card key={i} className="animate-pulse"><CardContent className="p-6"><div className="h-32 bg-gray-100 rounded" /></CardContent></Card>
          ))}
        </div>
      ) : !scenarios?.length ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <FileText className="h-12 w-12 mb-3 opacity-40" />
            <p className="font-medium">Nenhum cenário fiscal cadastrado</p>
            <p className="text-sm">Crie cenários fiscais para configurar os impostos de cada operação</p>
            <Button onClick={handleNew} variant="outline" className="mt-4">
              <Plus className="h-4 w-4 mr-2" />Criar primeiro cenário
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {scenarios.map(sc => (
            <Card key={sc.id} className={`relative transition-all hover:shadow-md ${!sc.isActive ? 'opacity-60' : ''}`}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-base truncate">{sc.name}</CardTitle>
                    <p className="text-xs text-muted-foreground mt-1">{sc.natureOfOperation || opLabel(sc.operationType)}</p>
                  </div>
                  {sc.isActive ? (
                    <Badge variant="default" className="bg-green-100 text-green-700 text-xs shrink-0">Ativo</Badge>
                  ) : (
                    <Badge variant="secondary" className="text-xs shrink-0">Inativo</Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-3 pt-0">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div><span className="text-muted-foreground">Operação:</span><br/><span className="font-medium">{opLabel(sc.operationType)}</span></div>
                  <div><span className="text-muted-foreground">Escopo:</span><br/><span className="font-medium">{scopeLabel(sc.stateScope)}</span></div>
                  <div><span className="text-muted-foreground">CFOP:</span><br/><span className="font-mono font-bold text-orange-600">{sc.cfop}</span></div>
                  <div>
                    <span className="text-muted-foreground">{sc.taxRegime === 'simples_nacional' ? 'CSOSN:' : 'CST ICMS:'}</span><br/>
                    <span className="font-mono font-medium">{sc.csosn || sc.cstIcms || '—'}</span>
                  </div>
                </div>

                <Separator />

                <div className="flex flex-wrap gap-1">
                  {sc.aliqIcms && <Badge variant="outline" className="text-[10px]">ICMS {sc.aliqIcms}%</Badge>}
                  {sc.aliqPis && <Badge variant="outline" className="text-[10px]">PIS {sc.aliqPis}%</Badge>}
                  {sc.aliqCofins && <Badge variant="outline" className="text-[10px]">COFINS {sc.aliqCofins}%</Badge>}
                  {sc.aliqIpi && <Badge variant="outline" className="text-[10px]">IPI {sc.aliqIpi}%</Badge>}
                  {sc.aliqIcmsSt && <Badge variant="outline" className="text-[10px]">ICMS ST {sc.aliqIcmsSt}%</Badge>}
                  {sc.aliqFcp && <Badge variant="outline" className="text-[10px]">FCP {sc.aliqFcp}%</Badge>}
                  {!sc.aliqIcms && !sc.aliqPis && !sc.aliqCofins && !sc.aliqIpi && (
                    <span className="text-xs text-muted-foreground">Sem alíquotas configuradas</span>
                  )}
                </div>

                {sc.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2">{sc.description}</p>
                )}

                <div className="flex gap-1 pt-1">
                  <Button size="sm" variant="outline" className="flex-1 h-8 text-xs" onClick={() => handleEdit(sc)}>
                    <Pencil className="h-3 w-3 mr-1" />Editar
                  </Button>
                  <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => handleDuplicate(sc)}>
                    <Copy className="h-3 w-3" />
                  </Button>
                  <Button size="sm" variant="outline" className="h-8 text-xs text-red-600 hover:text-red-700"
                    onClick={() => { if (confirm('Excluir este cenário fiscal?')) deleteMutation.mutate(sc.id); }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Editar Cenário Fiscal' : 'Novo Cenário Fiscal'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <TaxSection title="Identificação">
              <FormField label="Nome do Cenário *">
                <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Ex: Venda Interna GO - Padrão" />
              </FormField>
              <FormField label="Tipo de Operação *">
                <Select value={form.operationType} onValueChange={v => setForm(f => ({ ...f, operationType: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{OPERATION_TYPES.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                </Select>
              </FormField>
              <FormField label="Escopo Estadual *">
                <Select value={form.stateScope} onValueChange={v => setForm(f => ({ ...f, stateScope: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{STATE_SCOPES.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
                </Select>
              </FormField>
              <FormField label="Natureza da Operação">
                <Input value={form.natureOfOperation} onChange={e => setForm(f => ({ ...f, natureOfOperation: e.target.value }))} placeholder="Venda de Mercadoria" />
              </FormField>
              <FormField label="Regime Tributário">
                <Select value={form.taxRegime} onValueChange={v => setForm(f => ({ ...f, taxRegime: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{TAX_REGIMES.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}</SelectContent>
                </Select>
              </FormField>
              <div className="flex items-center gap-2 pt-5">
                <Switch checked={form.isActive} onCheckedChange={v => setForm(f => ({ ...f, isActive: v }))} />
                <Label className="text-sm">Cenário Ativo</Label>
              </div>
            </TaxSection>

            <TaxSection title="CFOP e Situação Tributária (CSOSN)">
              <FormField label="CFOP *">
                <Select value={form.cfop} onValueChange={v => setForm(f => ({ ...f, cfop: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{COMMON_CFOPS.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
                </Select>
              </FormField>
              {form.taxRegime === 'simples_nacional' ? (
                <FormField label="CSOSN (Simples Nacional)">
                  <Select value={form.csosn} onValueChange={v => setForm(f => ({ ...f, csosn: v }))}>
                    <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                    <SelectContent>{CSOSN_OPTIONS.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
                  </Select>
                </FormField>
              ) : (
                <FormField label="CST ICMS">
                  <Select value={form.cstIcms} onValueChange={v => setForm(f => ({ ...f, cstIcms: v }))}>
                    <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                    <SelectContent>{CST_ICMS_OPTIONS.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
                  </Select>
                </FormField>
              )}
            </TaxSection>

            <TaxSection title="ICMS (Simples Nacional)">
              <FormField label="Modalidade Base de Cálculo">
                <Select value={form.modalidadeBcIcms} onValueChange={v => setForm(f => ({ ...f, modalidadeBcIcms: v }))}>
                  <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                  <SelectContent>{MODALIDADE_BC_ICMS.map(m => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
                </Select>
              </FormField>
              <FormField label="Alíquota ICMS (%)">
                <Input type="number" step="0.01" value={form.aliqIcms} onChange={e => setForm(f => ({ ...f, aliqIcms: e.target.value }))} placeholder="0.00" />
              </FormField>
              <FormField label="Redução BC ICMS (%)">
                <Input type="number" step="0.01" value={form.redBcIcms} onChange={e => setForm(f => ({ ...f, redBcIcms: e.target.value }))} placeholder="0.00" />
              </FormField>
            </TaxSection>

            <TaxSection title="IPI">
              <FormField label="CST IPI">
                <Select value={form.cstIpi} onValueChange={v => setForm(f => ({ ...f, cstIpi: v }))}>
                  <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                  <SelectContent>{CST_IPI_OPTIONS.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
                </Select>
              </FormField>
              <FormField label="Alíquota IPI (%)">
                <Input type="number" step="0.01" value={form.aliqIpi} onChange={e => setForm(f => ({ ...f, aliqIpi: e.target.value }))} placeholder="0.00" />
              </FormField>
            </TaxSection>

            <TaxSection title="ICMS Interestadual (DIFAL)">
              <FormField label="Alíquota ICMS Interestadual (%)">
                <Input type="number" step="0.01" value={form.aliqIcmsInterestadual} onChange={e => setForm(f => ({ ...f, aliqIcmsInterestadual: e.target.value }))} placeholder="0.00" />
              </FormField>
              <FormField label="Alíquota ICMS Interna UF Destino (%)">
                <Input type="number" step="0.01" value={form.aliqIcmsInterna} onChange={e => setForm(f => ({ ...f, aliqIcmsInterna: e.target.value }))} placeholder="0.00" />
              </FormField>
              <FormField label="Alíquota FCP (%)">
                <Input type="number" step="0.01" value={form.aliqFcp} onChange={e => setForm(f => ({ ...f, aliqFcp: e.target.value }))} placeholder="0.00" />
              </FormField>
            </TaxSection>

            <TaxSection title="ICMS ST (Substituição Tributária)">
              <FormField label="Modalidade BC ICMS ST">
                <Select value={form.modalidadeBcIcmsSt} onValueChange={v => setForm(f => ({ ...f, modalidadeBcIcmsSt: v }))}>
                  <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                  <SelectContent>{MODALIDADE_BC_ICMS.map(m => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
                </Select>
              </FormField>
              <FormField label="MVA ICMS ST (%)">
                <Input type="number" step="0.01" value={form.mvaIcmsSt} onChange={e => setForm(f => ({ ...f, mvaIcmsSt: e.target.value }))} placeholder="0.00" />
              </FormField>
              <FormField label="Redução BC ICMS ST (%)">
                <Input type="number" step="0.01" value={form.redBcIcmsSt} onChange={e => setForm(f => ({ ...f, redBcIcmsSt: e.target.value }))} placeholder="0.00" />
              </FormField>
              <FormField label="Alíquota ICMS ST (%)">
                <Input type="number" step="0.01" value={form.aliqIcmsSt} onChange={e => setForm(f => ({ ...f, aliqIcmsSt: e.target.value }))} placeholder="0.00" />
              </FormField>
              <FormField label="Alíquota FCP ST (%)">
                <Input type="number" step="0.01" value={form.aliqFcpSt} onChange={e => setForm(f => ({ ...f, aliqFcpSt: e.target.value }))} placeholder="0.00" />
              </FormField>
            </TaxSection>

            <TaxSection title="PIS">
              <FormField label="CST PIS">
                <Select value={form.cstPis} onValueChange={v => setForm(f => ({ ...f, cstPis: v }))}>
                  <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                  <SelectContent>{CST_PIS_COFINS_OPTIONS.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
                </Select>
              </FormField>
              <FormField label="Alíquota PIS (%)">
                <Input type="number" step="0.0001" value={form.aliqPis} onChange={e => setForm(f => ({ ...f, aliqPis: e.target.value }))} placeholder="0.0000" />
              </FormField>
            </TaxSection>

            <TaxSection title="COFINS">
              <FormField label="CST COFINS">
                <Select value={form.cstCofins} onValueChange={v => setForm(f => ({ ...f, cstCofins: v }))}>
                  <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                  <SelectContent>{CST_PIS_COFINS_OPTIONS.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
                </Select>
              </FormField>
              <FormField label="Alíquota COFINS (%)">
                <Input type="number" step="0.0001" value={form.aliqCofins} onChange={e => setForm(f => ({ ...f, aliqCofins: e.target.value }))} placeholder="0.0000" />
              </FormField>
            </TaxSection>

            <FormField label="Observações">
              <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Observações sobre este cenário fiscal..." rows={3} />
            </FormField>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
              <Button onClick={() => saveMutation.mutate(form)} disabled={saveMutation.isPending || !form.name || !form.cfop}
                className="bg-orange-600 hover:bg-orange-700">
                {saveMutation.isPending ? "Salvando..." : editingId ? "Salvar Alterações" : "Criar Cenário"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}