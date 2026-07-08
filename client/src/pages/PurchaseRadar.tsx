import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  Radar, Upload, FileText, Package, DollarSign, Search,
  Filter, Eye, Tag, Truck, CheckCircle2, XCircle,
  ArrowRight, BarChart3, AlertCircle, RefreshCw, Trash2, Plus
} from "lucide-react";

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  detected: { label: "Detectada", color: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200" },
  imported: { label: "Importada", color: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" },
  classified: { label: "Classificada", color: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200" },
  linked: { label: "Vinculada", color: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" },
  paid: { label: "Paga", color: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200" },
  cancelled: { label: "Cancelada", color: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200" },
};

function formatCurrency(val: string | number | null) {
  const n = typeof val === "string" ? parseFloat(val) : val;
  if (!n && n !== 0) return "R$ 0,00";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n);
}

function formatDoc(doc: string) {
  const d = doc?.replace(/\D/g, "") || "";
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  return doc;
}

function formatDate(d: string | null) {
  if (!d) return "-";
  return new Date(d).toLocaleDateString("pt-BR");
}

export default function PurchaseRadar() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("list");
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [xmlContent, setXmlContent] = useState("");
  const [selectedInvoice, setSelectedInvoice] = useState<any>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [showClassify, setShowClassify] = useState(false);
  const [showPayable, setShowPayable] = useState(false);
  const [showEntry, setShowEntry] = useState(false);
  const [entryMappings, setEntryMappings] = useState<any[]>([]);

  const [classifyData, setClassifyData] = useState({ chartAccountId: "", isStockPurchase: false, notes: "" });
  const [payableData, setPayableData] = useState({ dueDate: "", financialAccountId: "", paymentMethod: "boleto", description: "" });

  const { data: invoices = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/purchases", statusFilter, search],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (search) params.set("search", search);
      const res = await fetch(`/api/purchases?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Erro ao carregar notas");
      return res.json();
    },
  });

  const { data: stats } = useQuery<any>({
    queryKey: ["/api/purchases/stats/summary"],
  });

  const { data: chartAccounts = [] } = useQuery<any[]>({
    queryKey: ["/api/chart-of-accounts"],
  });

  const { data: instances = [] } = useQuery<any[]>({
    queryKey: ["/api/omie/instances"],
  });

  const { data: certificates = [] } = useQuery<any[]>({
    queryKey: ["/api/purchases/certificates-status"],
  });

  const { data: rawMaterials = [] } = useQuery<any[]>({
    queryKey: ["/api/synced-table/raw_materials"],
    queryFn: async () => {
      const res = await fetch("/api/synced-table/raw_materials?limit=1000", { credentials: "include" });
      if (!res.ok) return [];
      const j = await res.json();
      return (j.rows || []).filter((m: any) => m.is_active !== false);
    },
  });

  const importXml = useMutation({
    mutationFn: async (xml: string) => {
      const res = await apiRequest("POST", "/api/purchases/import-xml", { xmlContent: xml });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "XML importado", description: `NF ${data.invoiceNumber || "s/n"} de ${data.supplierName} importada com sucesso.` });
      setXmlContent("");
      setActiveTab("list");
      queryClient.invalidateQueries({ queryKey: ["/api/purchases"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchases/stats/summary"] });
    },
    onError: (err: any) => {
      toast({ title: "Erro na importação", description: err.message, variant: "destructive" });
    },
  });

  const classify = useMutation({
    mutationFn: async ({ id, ...data }: any) => {
      const res = await apiRequest("PATCH", `/api/purchases/${id}/classify`, data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "NF classificada" });
      setShowClassify(false);
      queryClient.invalidateQueries({ queryKey: ["/api/purchases"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchases/stats/summary"] });
    },
    onError: (err: any) => toast({ title: "Erro", description: err.message, variant: "destructive" }),
  });

  const createPayable = useMutation({
    mutationFn: async ({ id, ...data }: any) => {
      const res = await apiRequest("POST", `/api/purchases/${id}/create-payable`, data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Conta a pagar criada" });
      setShowPayable(false);
      queryClient.invalidateQueries({ queryKey: ["/api/purchases"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchases/stats/summary"] });
    },
    onError: (err: any) => toast({ title: "Erro", description: err.message, variant: "destructive" }),
  });

  const processRaw = useMutation({
    mutationFn: async ({ id, itemMappings }: any) => {
      const res = await apiRequest("POST", `/api/purchases/${id}/process-raw-materials`, { itemMappings });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Entrada de matéria-prima registrada" });
      setShowEntry(false);
      queryClient.invalidateQueries({ queryKey: ["/api/purchases"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchases/stats/summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/synced-table/raw_materials"] });
    },
    onError: (err: any) => toast({ title: "Erro", description: err.message, variant: "destructive" }),
  });

  const updateStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const res = await apiRequest("PATCH", `/api/purchases/${id}/status`, { status });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: `Status atualizado para ${STATUS_MAP[data.status]?.label || data.status}` });
      setSelectedInvoice(data);
      queryClient.invalidateQueries({ queryKey: ["/api/purchases"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchases/stats/summary"] });
    },
    onError: (err: any) => toast({ title: "Erro", description: err.message, variant: "destructive" }),
  });

  const deleteInvoice = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/purchases/${id}`);
    },
    onSuccess: () => {
      toast({ title: "NF removida" });
      setShowDetail(false);
      queryClient.invalidateQueries({ queryKey: ["/api/purchases"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchases/stats/summary"] });
    },
  });

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result as string;
      setXmlContent(content);
    };
    reader.readAsText(file);
  }, []);

  const expenseAccounts = chartAccounts.filter((a: any) => a.type === "expense" || a.type === "despesa");

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-[1400px] mx-auto">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Radar className="h-7 w-7 text-primary" />
            Compras
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Importação, classificação e controle de notas fiscais de entrada
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card className="col-span-1">
          <CardContent className="pt-4 pb-3 px-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <FileText className="h-4 w-4" />
              Total NFs
            </div>
            <p className="text-2xl font-bold">{stats?.total || 0}</p>
          </CardContent>
        </Card>
        <Card className="col-span-1">
          <CardContent className="pt-4 pb-3 px-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Upload className="h-4 w-4" />
              Importadas
            </div>
            <p className="text-2xl font-bold text-blue-600">{stats?.imported || 0}</p>
          </CardContent>
        </Card>
        <Card className="col-span-1">
          <CardContent className="pt-4 pb-3 px-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Tag className="h-4 w-4" />
              Classificadas
            </div>
            <p className="text-2xl font-bold text-purple-600">{stats?.classified || 0}</p>
          </CardContent>
        </Card>
        <Card className="col-span-1">
          <CardContent className="pt-4 pb-3 px-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <DollarSign className="h-4 w-4" />
              Vinculadas
            </div>
            <p className="text-2xl font-bold text-green-600">{stats?.linked || 0}</p>
          </CardContent>
        </Card>
        <Card className="col-span-2 md:col-span-1">
          <CardContent className="pt-4 pb-3 px-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <BarChart3 className="h-4 w-4" />
              Valor Total
            </div>
            <p className="text-lg font-bold">{formatCurrency(stats?.total_value)}</p>
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="list">
            <FileText className="h-4 w-4 mr-1" /> Notas Fiscais
          </TabsTrigger>
          <TabsTrigger value="import">
            <Upload className="h-4 w-4 mr-1" /> Importar XML
          </TabsTrigger>
          <TabsTrigger value="radar">
            <Radar className="h-4 w-4 mr-1" /> Radar SEFAZ
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="space-y-4">
          <div className="flex flex-col md:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por fornecedor, CNPJ, número..."
                className="pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[180px]">
                <Filter className="h-4 w-4 mr-1" />
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="detected">Detectadas</SelectItem>
                <SelectItem value="imported">Importadas</SelectItem>
                <SelectItem value="classified">Classificadas</SelectItem>
                <SelectItem value="linked">Vinculadas</SelectItem>
                <SelectItem value="paid">Pagas</SelectItem>
                <SelectItem value="cancelled">Canceladas</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {isLoading ? (
            <div className="text-center py-12 text-muted-foreground">Carregando...</div>
          ) : invoices.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Radar className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
                <h3 className="text-lg font-medium mb-1">Nenhuma nota fiscal encontrada</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Importe um XML de NF-e ou ative o radar automático
                </p>
                <Button onClick={() => setActiveTab("import")}>
                  <Upload className="h-4 w-4 mr-1" /> Importar XML
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {invoices.map((inv: any) => {
                const st = STATUS_MAP[inv.status] || STATUS_MAP.detected;
                const instance = instances.find((i: any) => i.id === inv.omieInstanceId);
                return (
                  <Card
                    key={inv.id}
                    className="hover:shadow-md transition-shadow cursor-pointer"
                    onClick={() => { setSelectedInvoice(inv); setShowDetail(true); }}
                  >
                    <CardContent className="py-3 px-4">
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold truncate">{inv.supplierName}</span>
                            <Badge className={st.color}>{st.label}</Badge>
                            {instance && (
                              <Badge variant="outline" style={{ borderColor: instance.tagColor, color: instance.tagColor }}>
                                {instance.name}
                              </Badge>
                            )}
                            {inv.isStockPurchase && (
                              <Badge variant="secondary"><Package className="h-3 w-3 mr-1" />Estoque</Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-4 text-sm text-muted-foreground mt-1">
                            <span>NF {inv.invoiceNumber || "s/n"}</span>
                            <span>{formatDoc(inv.supplierDocument)}</span>
                            <span>{formatDate(inv.issueDate)}</span>
                            {inv.cfop && <span>CFOP {inv.cfop}</span>}
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-lg font-bold">{formatCurrency(inv.totalValue)}</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="import" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Upload className="h-5 w-5" />
                Importar NF-e via XML
              </CardTitle>
              <CardDescription>
                Faça upload do arquivo XML da nota fiscal de entrada ou cole o conteúdo XML
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Arquivo XML</Label>
                <Input type="file" accept=".xml" onChange={handleFileUpload} className="mt-1" />
              </div>

              <div className="relative">
                <div className="absolute inset-0 flex items-center"><Separator /></div>
                <div className="relative flex justify-center"><span className="bg-background px-2 text-xs text-muted-foreground">OU</span></div>
              </div>

              <div>
                <Label>Conteúdo XML</Label>
                <Textarea
                  placeholder="Cole o conteúdo XML da NF-e aqui..."
                  rows={8}
                  value={xmlContent}
                  onChange={(e) => setXmlContent(e.target.value)}
                  className="mt-1 font-mono text-xs"
                />
              </div>

              <Button
                onClick={() => importXml.mutate(xmlContent)}
                disabled={!xmlContent || importXml.isPending}
                className="w-full"
              >
                {importXml.isPending ? "Importando..." : "Importar NF-e"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="radar" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Radar className="h-5 w-5" />
                Radar Automático SEFAZ
              </CardTitle>
              <CardDescription>
                Busca automática de NF-e emitidas contra os CNPJs das instâncias cadastradas
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {(() => {
                const certData = certificates as any;
                const certInstances = certData?.instances || [];
                const unmatchedCerts = certData?.unmatchedCertificates || [];
                const totalCerts = certData?.totalCertificates || 0;
                const allReady = certInstances.length > 0 && certInstances.every((i: any) => i.hasCertificate && i.certificateValid && i.cnpj);

                return (
                  <>
                    {allReady ? (
                      <div className="bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-lg p-4">
                        <div className="flex items-start gap-3">
                          <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5" />
                          <div>
                            <h4 className="font-medium text-green-800 dark:text-green-200">Radar Pronto</h4>
                            <p className="text-sm text-green-700 dark:text-green-300 mt-1">
                              Todas as instâncias possuem CNPJ e certificado digital A1 válido configurados.
                              O radar automático pode ser ativado para detectar NF-e emitidas contra seus CNPJs.
                            </p>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
                        <div className="flex items-start gap-3">
                          <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5" />
                          <div>
                            <h4 className="font-medium text-amber-800 dark:text-amber-200">Configuração Necessária</h4>
                            <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                              Para ativar o radar automático, cada instância Omie precisa ter um CNPJ cadastrado e
                              um certificado digital A1 válido configurado no módulo Indústria → Documentação.
                              O certificado deve ter o mesmo CNPJ da instância.
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    <div>
                      <h4 className="font-medium mb-2">Status das Instâncias ({certInstances.length})</h4>
                      {certInstances.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          Nenhuma instância Omie ativa encontrada. Acesse Administração → Instâncias Omie para configurar.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {certInstances.map((inst: any) => (
                            <div key={inst.instanceId} className="flex items-center justify-between p-3 border rounded-lg">
                              <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: inst.tagColor }} />
                                <span className="font-medium">{inst.instanceName}</span>
                                {inst.cnpj ? (
                                  <span className="text-sm text-muted-foreground">{formatDoc(inst.cnpj)}</span>
                                ) : (
                                  <span className="text-sm text-red-500">Sem CNPJ</span>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                {inst.hasCertificate ? (
                                  inst.certificateValid ? (
                                    <Badge variant="default" className="bg-green-600">
                                      Certificado válido
                                    </Badge>
                                  ) : (
                                    <Badge variant="destructive">Certificado expirado</Badge>
                                  )
                                ) : inst.cnpj ? (
                                  <Badge variant="outline" className="text-amber-600 border-amber-300">
                                    Sem certificado
                                  </Badge>
                                ) : (
                                  <Badge variant="outline" className="text-red-500 border-red-300">
                                    CNPJ necessário
                                  </Badge>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {unmatchedCerts.length > 0 && (
                      <div>
                        <h4 className="font-medium mb-2 text-amber-600">Certificados não vinculados ({unmatchedCerts.length})</h4>
                        <p className="text-sm text-muted-foreground mb-2">
                          Estes certificados estão cadastrados mas não correspondem ao CNPJ de nenhuma instância:
                        </p>
                        <div className="space-y-1">
                          {unmatchedCerts.map((cert: any) => (
                            <div key={cert.id} className="flex items-center justify-between p-2 border rounded text-sm">
                              <span>{cert.companyName} ({formatDoc(cert.cnpj)})</span>
                              <Badge variant="outline">Não vinculado</Badge>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {totalCerts === 0 && (
                      <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                        <p className="text-sm text-blue-700 dark:text-blue-300">
                          Nenhum certificado digital cadastrado. Para cadastrar, acesse <strong>Indústria → Documentação</strong> e 
                          faça o upload do arquivo PFX/P12 do certificado A1 de cada empresa.
                        </p>
                      </div>
                    )}
                  </>
                );
              })()}

              <p className="text-sm text-muted-foreground">
                Enquanto o radar automático não estiver ativo, utilize a importação manual de XML na aba "Importar XML".
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={showDetail} onOpenChange={setShowDetail}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Detalhes da NF de Compra</DialogTitle>
            <DialogDescription>NF {selectedInvoice?.invoiceNumber || "s/n"}</DialogDescription>
          </DialogHeader>
          {selectedInvoice && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs text-muted-foreground">Fornecedor</Label>
                  <p className="font-medium">{selectedInvoice.supplierName}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">CNPJ/CPF</Label>
                  <p>{formatDoc(selectedInvoice.supplierDocument)}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Data Emissão</Label>
                  <p>{formatDate(selectedInvoice.issueDate)}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Valor Total</Label>
                  <p className="font-bold text-lg">{formatCurrency(selectedInvoice.totalValue)}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Status</Label>
                  <Badge className={STATUS_MAP[selectedInvoice.status]?.color}>
                    {STATUS_MAP[selectedInvoice.status]?.label}
                  </Badge>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">CFOP</Label>
                  <p>{selectedInvoice.cfop || "-"}</p>
                </div>
              </div>

              {selectedInvoice.accessKey && (
                <div>
                  <Label className="text-xs text-muted-foreground">Chave de Acesso</Label>
                  <p className="font-mono text-xs break-all">{selectedInvoice.accessKey}</p>
                </div>
              )}

              {Array.isArray(selectedInvoice.items) && selectedInvoice.items.length > 0 && (
                <div>
                  <Label className="text-xs text-muted-foreground mb-2 block">Itens ({selectedInvoice.items.length})</Label>
                  <div className="border rounded-lg overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted">
                        <tr>
                          <th className="text-left p-2">#</th>
                          <th className="text-left p-2">Produto</th>
                          <th className="text-right p-2">Qtd</th>
                          <th className="text-right p-2">Vlr Unit</th>
                          <th className="text-right p-2">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedInvoice.items.map((item: any, i: number) => (
                          <tr key={i} className="border-t">
                            <td className="p-2">{item.nItem || i + 1}</td>
                            <td className="p-2">{item.xProd}</td>
                            <td className="text-right p-2">{item.qCom}</td>
                            <td className="text-right p-2">{formatCurrency(item.vUnCom)}</td>
                            <td className="text-right p-2">{formatCurrency(item.vProd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {selectedInvoice.taxes && Object.keys(selectedInvoice.taxes).length > 0 && (
                <div>
                  <Label className="text-xs text-muted-foreground mb-2 block">Impostos</Label>
                  <div className="grid grid-cols-3 gap-2">
                    {Object.entries(selectedInvoice.taxes).map(([key, val]: [string, any]) => (
                      val && val !== "0" && val !== "0.00" ? (
                        <div key={key} className="bg-muted rounded p-2">
                          <span className="text-xs text-muted-foreground">{key}</span>
                          <p className="font-medium text-sm">{formatCurrency(val)}</p>
                        </div>
                      ) : null
                    ))}
                  </div>
                </div>
              )}

              <Separator />

              <div className="flex flex-wrap gap-2">
                {(selectedInvoice.status === "imported") && (
                  <Button
                    size="sm"
                    onClick={() => {
                      setClassifyData({ chartAccountId: "", isStockPurchase: false, notes: "" });
                      setShowClassify(true);
                    }}
                  >
                    <Tag className="h-4 w-4 mr-1" /> Classificar
                  </Button>
                )}
                {(selectedInvoice.status === "classified") && !selectedInvoice.payableId && (
                  <Button
                    size="sm"
                    onClick={() => {
                      setPayableData({ dueDate: "", financialAccountId: "", paymentMethod: "boleto", description: "" });
                      setShowPayable(true);
                    }}
                  >
                    <DollarSign className="h-4 w-4 mr-1" /> Criar Conta a Pagar
                  </Button>
                )}
                {(selectedInvoice.status === "linked") && (
                  <Button
                    size="sm"
                    variant="default"
                    className="bg-emerald-600 hover:bg-emerald-700"
                    onClick={() => updateStatus.mutate({ id: selectedInvoice.id, status: "paid" })}
                    disabled={updateStatus.isPending}
                  >
                    <CheckCircle2 className="h-4 w-4 mr-1" /> Marcar como Paga
                  </Button>
                )}
                {["classified", "linked"].includes(selectedInvoice.status) && selectedInvoice.isStockPurchase && !selectedInvoice.stockProcessed && (
                  <Button
                    size="sm"
                    variant="default"
                    className="bg-amber-600 hover:bg-amber-700"
                    onClick={() => {
                      const its = Array.isArray(selectedInvoice.items) ? selectedInvoice.items : [];
                      setEntryMappings(its.map((it: any) => ({ rawMaterialId: "", quantity: it.qCom || "", unitCost: it.vUnCom || "", label: it.xProd || "" })));
                      setShowEntry(true);
                    }}
                  >
                    <Package className="h-4 w-4 mr-1" /> Dar entrada (matéria-prima)
                  </Button>
                )}
                {selectedInvoice.isStockPurchase && selectedInvoice.stockProcessed && (
                  <Badge className="bg-emerald-100 text-emerald-800 self-center"><CheckCircle2 className="h-3 w-3 mr-1 inline" />Estoque processado</Badge>
                )}
                {!["paid", "cancelled"].includes(selectedInvoice.status) && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-red-600 border-red-300 hover:bg-red-50"
                    onClick={() => updateStatus.mutate({ id: selectedInvoice.id, status: "cancelled" })}
                    disabled={updateStatus.isPending}
                  >
                    <XCircle className="h-4 w-4 mr-1" /> Cancelar
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => deleteInvoice.mutate(selectedInvoice.id)}
                >
                  <Trash2 className="h-4 w-4 mr-1" /> Excluir
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={showClassify} onOpenChange={setShowClassify}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Classificar NF de Compra</DialogTitle>
            <DialogDescription>Selecione a categoria de despesa e se é compra para estoque</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Categoria (Plano de Contas)</Label>
              <Select value={classifyData.chartAccountId} onValueChange={(v) => setClassifyData(prev => ({ ...prev, chartAccountId: v }))}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Selecione a categoria..." />
                </SelectTrigger>
                <SelectContent>
                  {chartAccounts.map((acc: any) => (
                    <SelectItem key={acc.id} value={acc.id}>
                      {acc.code ? `${acc.code} - ` : ""}{acc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="isStock"
                checked={classifyData.isStockPurchase}
                onCheckedChange={(v) => setClassifyData(prev => ({ ...prev, isStockPurchase: !!v }))}
              />
              <Label htmlFor="isStock" className="cursor-pointer">
                <Package className="h-4 w-4 inline mr-1" />
                Compra para estoque (habilita entrada de estoque)
              </Label>
            </div>

            <div>
              <Label>Observações</Label>
              <Textarea
                value={classifyData.notes}
                onChange={(e) => setClassifyData(prev => ({ ...prev, notes: e.target.value }))}
                className="mt-1"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowClassify(false)}>Cancelar</Button>
            <Button
              disabled={!classifyData.chartAccountId || classify.isPending}
              onClick={() => classify.mutate({ id: selectedInvoice?.id, ...classifyData })}
            >
              {classify.isPending ? "Salvando..." : "Classificar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showPayable} onOpenChange={setShowPayable}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Criar Conta a Pagar</DialogTitle>
            <DialogDescription>
              Vincular NF {selectedInvoice?.invoiceNumber} a uma conta a pagar - {formatCurrency(selectedInvoice?.totalValue)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Data de Vencimento</Label>
              <Input
                type="date"
                value={payableData.dueDate}
                onChange={(e) => setPayableData(prev => ({ ...prev, dueDate: e.target.value }))}
                className="mt-1"
              />
            </div>
            <div>
              <Label>Forma de Pagamento</Label>
              <Select value={payableData.paymentMethod} onValueChange={(v) => setPayableData(prev => ({ ...prev, paymentMethod: v }))}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="boleto">Boleto</SelectItem>
                  <SelectItem value="pix">PIX</SelectItem>
                  <SelectItem value="transferencia">Transferência</SelectItem>
                  <SelectItem value="cartao">Cartão</SelectItem>
                  <SelectItem value="dinheiro">Dinheiro</SelectItem>
                  <SelectItem value="cheque">Cheque</SelectItem>
                  <SelectItem value="outro">Outro</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Descrição</Label>
              <Input
                value={payableData.description}
                onChange={(e) => setPayableData(prev => ({ ...prev, description: e.target.value }))}
                placeholder={`Compra NF ${selectedInvoice?.invoiceNumber} - ${selectedInvoice?.supplierName}`}
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPayable(false)}>Cancelar</Button>
            <Button
              disabled={!payableData.dueDate || createPayable.isPending}
              onClick={() => createPayable.mutate({ id: selectedInvoice?.id, ...payableData })}
            >
              {createPayable.isPending ? "Criando..." : "Criar Conta a Pagar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showEntry} onOpenChange={setShowEntry}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Dar entrada — Matéria-Prima</DialogTitle>
            <DialogDescription>
              Para cada item da NF {selectedInvoice?.invoiceNumber}, escolha a matéria-prima que receberá a entrada, a quantidade e o custo unitário. Itens sem matéria-prima selecionada são ignorados.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="border rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted">
                  <tr>
                    <th className="text-left p-2">Item da NF</th>
                    <th className="text-left p-2">Matéria-Prima</th>
                    <th className="text-right p-2">Quantidade</th>
                    <th className="text-right p-2">Custo Unit.</th>
                  </tr>
                </thead>
                <tbody>
                  {entryMappings.map((m: any, i: number) => (
                    <tr key={i} className="border-t align-top">
                      <td className="p-2 max-w-[220px]">{m.label || `Item ${i + 1}`}</td>
                      <td className="p-2 min-w-[220px]">
                        <Select value={m.rawMaterialId} onValueChange={(v) => setEntryMappings((prev) => prev.map((x, j) => j === i ? { ...x, rawMaterialId: v } : x))}>
                          <SelectTrigger><SelectValue placeholder="Selecione (ou ignore)..." /></SelectTrigger>
                          <SelectContent>
                            {rawMaterials.map((rm: any) => (
                              <SelectItem key={rm.id} value={rm.id}>{rm.name}{rm.unit ? ` (${rm.quantity} ${rm.unit})` : ""}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="p-2 w-28">
                        <Input type="number" step="0.001" value={m.quantity} onChange={(e) => setEntryMappings((prev) => prev.map((x, j) => j === i ? { ...x, quantity: e.target.value } : x))} className="text-right" />
                      </td>
                      <td className="p-2 w-28">
                        <Input type="number" step="0.0001" value={m.unitCost} onChange={(e) => setEntryMappings((prev) => prev.map((x, j) => j === i ? { ...x, unitCost: e.target.value } : x))} className="text-right" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">A entrada soma à quantidade da matéria-prima e registra um movimento de "entrada_compra" (com custo unitário). Não afeta o estoque de produtos acabados.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEntry(false)}>Cancelar</Button>
            <Button
              className="bg-amber-600 hover:bg-amber-700"
              disabled={processRaw.isPending || !entryMappings.some((m: any) => m.rawMaterialId && Number(m.quantity) > 0)}
              onClick={() => processRaw.mutate({ id: selectedInvoice?.id, itemMappings: entryMappings.filter((m: any) => m.rawMaterialId && Number(m.quantity) > 0) })}
            >
              {processRaw.isPending ? "Registrando..." : "Confirmar entrada"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
