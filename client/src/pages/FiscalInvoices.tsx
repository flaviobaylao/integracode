import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';
import BackToDashboardButton from '@/components/BackToDashboardButton';
import {
  FileText, Plus, Send, XCircle, Trash2, Eye, RefreshCw,
  CheckCircle2, Clock, AlertTriangle, ShieldCheck, Award,
  Loader2, ChevronLeft
} from 'lucide-react';

interface FiscalInvoice {
  id: string;
  invoiceNumber: string;
  series: string;
  customerName: string;
  customerCnpjCpf: string;
  cfop: string;
  natureOfOperation: string;
  status: string;
  environment: string;
  totalProducts: string;
  totalInvoice: string;
  paymentMethod: string;
  notes: string;
  accessKey: string;
  protocolNumber: string;
  fiscalScenarioId: string;
  createdAt: string;
  updatedAt: string;
  items?: FiscalInvoiceItem[];
  events?: FiscalInvoiceEvent[];
}

interface FiscalInvoiceItem {
  id: string;
  invoiceId: string;
  itemNumber: number;
  productCode: string;
  productName: string;
  ncm: string;
  cfop: string;
  quantity: string;
  unitPrice: string;
  totalPrice: string;
  discount: string;
}

interface FiscalInvoiceEvent {
  id: string;
  invoiceId: string;
  eventType: string;
  status: string;
  description: string;
  sefazResponse: string;
  createdBy: string;
  createdAt: string;
}

interface FiscalScenario {
  id: string;
  name: string;
  cfop: string;
  natureOfOperation: string;
  taxRegime: string;
  icmsRate: string;
  pisRate: string;
  cofinsRate: string;
  ipiRate: string;
  isActive: boolean;
  createdAt: string;
}

interface DigitalCertificate {
  id: string;
  companyName: string;
  cnpj: string;
  serialNumber: string;
  issuer: string;
  validFrom: string;
  validUntil: string;
  certificateType: string;
  isActive: boolean;
  createdAt: string;
}

interface DashboardStats {
  totalInvoices: number;
  byStatus: {
    draft: number;
    authorized: number;
    cancelled: number;
    rejected: number;
  };
  totalValue: number;
  totalScenarios: number;
  activeCertificates: number;
}

const statusConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; className: string }> = {
  draft: { label: 'Rascunho', variant: 'secondary', className: 'bg-yellow-100 text-yellow-800 border-yellow-300' },
  authorized: { label: 'Autorizada', variant: 'default', className: 'bg-green-100 text-green-800 border-green-300' },
  cancelled: { label: 'Cancelada', variant: 'destructive', className: 'bg-red-100 text-red-800 border-red-300' },
  rejected: { label: 'Rejeitada', variant: 'outline', className: 'bg-orange-100 text-orange-800 border-orange-300' },
  processing: { label: 'Processando', variant: 'default', className: 'bg-blue-100 text-blue-800 border-blue-300' },
};

function getStatusBadge(status: string) {
  const config = statusConfig[status] || { label: status, variant: 'outline' as const, className: '' };
  return <Badge variant={config.variant} className={config.className}>{config.label}</Badge>;
}

function formatCurrency(value: string | number) {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return 'R$ 0,00';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(num);
}

function formatDate(dateString: string) {
  if (!dateString) return '-';
  return new Date(dateString).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function formatDateTime(dateString: string) {
  if (!dateString) return '-';
  return new Date(dateString).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

export default function FiscalInvoices() {
  const [activeTab, setActiveTab] = useState('invoices');
  const [statusFilter, setStatusFilter] = useState('all');
  const [envFilter, setEnvFilter] = useState('all');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showDetailDialog, setShowDetailDialog] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const [cancelJustification, setCancelJustification] = useState('');
  const [newInvoice, setNewInvoice] = useState({
    customerName: '',
    customerCnpjCpf: '',
    fiscalScenarioId: '',
    cfop: '',
    natureOfOperation: '',
    paymentMethod: 'a_vista',
    environment: 'homologacao',
    notes: '',
    items: [] as Array<{ productCode: string; productName: string; ncm: string; cfop: string; quantity: string; unitPrice: string }>,
  });
  const [newItem, setNewItem] = useState({ productCode: '', productName: '', ncm: '', cfop: '', quantity: '1', unitPrice: '0' });

  const { data: stats, isLoading: loadingStats } = useQuery<DashboardStats>({
    queryKey: ['/api/fiscal-dashboard'],
  });

  const buildInvoiceUrl = () => {
    const params = new URLSearchParams();
    if (statusFilter !== 'all') params.set('status', statusFilter);
    if (envFilter !== 'all') params.set('environment', envFilter);
    const qs = params.toString();
    return `/api/fiscal-invoices${qs ? `?${qs}` : ''}`;
  };

  const { data: invoices, isLoading: loadingInvoices } = useQuery<FiscalInvoice[]>({
    queryKey: ['/api/fiscal-invoices', statusFilter, envFilter],
    queryFn: () => fetch(buildInvoiceUrl(), { credentials: 'include' }).then(r => r.json()),
  });

  const { data: invoiceDetail, isLoading: loadingDetail } = useQuery<FiscalInvoice>({
    queryKey: ['/api/fiscal-invoices', selectedInvoiceId],
    queryFn: () => fetch(`/api/fiscal-invoices/${selectedInvoiceId}`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!selectedInvoiceId && showDetailDialog,
  });

  const { data: scenarios } = useQuery<FiscalScenario[]>({
    queryKey: ['/api/fiscal-scenarios'],
  });

  const { data: certificates } = useQuery<DigitalCertificate[]>({
    queryKey: ['/api/digital-certificates'],
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest('POST', '/api/fiscal-invoices', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/fiscal-invoices'] });
      queryClient.invalidateQueries({ queryKey: ['/api/fiscal-dashboard'] });
      setShowCreateDialog(false);
      resetNewInvoice();
      toast({ title: 'NF-e criada', description: 'Nota fiscal criada com sucesso.' });
    },
    onError: (err: any) => {
      toast({ title: 'Erro ao criar NF-e', description: err.message, variant: 'destructive' });
    },
  });

  const emitMutation = useMutation({
    mutationFn: (id: string) => apiRequest('POST', `/api/fiscal-invoices/${id}/emit`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/fiscal-invoices'] });
      queryClient.invalidateQueries({ queryKey: ['/api/fiscal-dashboard'] });
      toast({ title: 'NF-e emitida', description: 'Nota fiscal enviada para a SEFAZ.' });
    },
    onError: (err: any) => {
      toast({ title: 'Erro ao emitir NF-e', description: err.message, variant: 'destructive' });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: ({ id, justification }: { id: string; justification: string }) =>
      apiRequest('POST', `/api/fiscal-invoices/${id}/cancel`, { justification }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/fiscal-invoices'] });
      queryClient.invalidateQueries({ queryKey: ['/api/fiscal-dashboard'] });
      setShowCancelDialog(false);
      setCancelJustification('');
      toast({ title: 'NF-e cancelada', description: 'Nota fiscal cancelada com sucesso.' });
    },
    onError: (err: any) => {
      toast({ title: 'Erro ao cancelar NF-e', description: err.message, variant: 'destructive' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/fiscal-invoices/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/fiscal-invoices'] });
      queryClient.invalidateQueries({ queryKey: ['/api/fiscal-dashboard'] });
      toast({ title: 'NF-e excluída', description: 'Nota fiscal excluída com sucesso.' });
    },
    onError: (err: any) => {
      toast({ title: 'Erro ao excluir NF-e', description: err.message, variant: 'destructive' });
    },
  });

  function resetNewInvoice() {
    setNewInvoice({
      customerName: '', customerCnpjCpf: '', fiscalScenarioId: '', cfop: '',
      natureOfOperation: '', paymentMethod: 'a_vista', environment: 'homologacao', notes: '', items: [],
    });
    setNewItem({ productCode: '', productName: '', ncm: '', cfop: '', quantity: '1', unitPrice: '0' });
  }

  function handleAddItem() {
    if (!newItem.productName || !newItem.unitPrice) return;
    setNewInvoice(prev => ({
      ...prev,
      items: [...prev.items, { ...newItem }],
    }));
    setNewItem({ productCode: '', productName: '', ncm: '', cfop: '', quantity: '1', unitPrice: '0' });
  }

  function handleRemoveItem(index: number) {
    setNewInvoice(prev => ({
      ...prev,
      items: prev.items.filter((_, i) => i !== index),
    }));
  }

  function handleCreateInvoice() {
    if (!newInvoice.customerName || !newInvoice.customerCnpjCpf) {
      toast({ title: 'Campos obrigatórios', description: 'Preencha o nome e CPF/CNPJ do cliente.', variant: 'destructive' });
      return;
    }
    createMutation.mutate(newInvoice);
  }

  function handleScenarioSelect(scenarioId: string) {
    const scenario = scenarios?.find(s => s.id === scenarioId);
    if (scenario) {
      setNewInvoice(prev => ({
        ...prev,
        fiscalScenarioId: scenarioId,
        cfop: scenario.cfop,
        natureOfOperation: scenario.natureOfOperation,
      }));
    }
  }

  function openDetail(id: string) {
    setSelectedInvoiceId(id);
    setShowDetailDialog(true);
  }

  function openCancel(id: string) {
    setSelectedInvoiceId(id);
    setShowCancelDialog(true);
  }

  function isCertificateExpired(validUntil: string) {
    if (!validUntil) return false;
    return new Date(validUntil) < new Date();
  }

  function isCertificateExpiringSoon(validUntil: string) {
    if (!validUntil) return false;
    const days30 = new Date();
    days30.setDate(days30.getDate() + 30);
    return new Date(validUntil) < days30 && new Date(validUntil) >= new Date();
  }

  return (
    <div className="p-6 space-y-6">
      <BackToDashboardButton />

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-3">
          <FileText className="h-8 w-8 text-blue-600" />
          <div>
            <h1 className="text-3xl font-bold">Faturamento NF-e</h1>
            <p className="text-muted-foreground">Gestão de notas fiscais eletrônicas</p>
          </div>
        </div>
        <Button onClick={() => setShowCreateDialog(true)} className="bg-blue-600 hover:bg-blue-700">
          <Plus className="w-4 h-4 mr-2" />
          Nova NF-e
        </Button>
      </div>

      {/* Dashboard Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total NF-es</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{loadingStats ? '...' : (stats?.totalInvoices || 0)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Autorizadas</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{loadingStats ? '...' : (stats?.byStatus?.authorized || 0)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Rascunho</CardTitle>
            <Clock className="h-4 w-4 text-yellow-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">{loadingStats ? '...' : (stats?.byStatus?.draft || 0)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Valor Total Autorizado</CardTitle>
            <Award className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">{loadingStats ? '...' : formatCurrency(stats?.totalValue || 0)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="invoices">Notas Fiscais</TabsTrigger>
          <TabsTrigger value="scenarios">Cenários Fiscais</TabsTrigger>
          <TabsTrigger value="certificates">Certificados Digitais</TabsTrigger>
        </TabsList>

        {/* Tab: Notas Fiscais */}
        <TabsContent value="invoices" className="space-y-4">
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <Label className="text-xs">Status</Label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="draft">Rascunho</SelectItem>
                  <SelectItem value="authorized">Autorizada</SelectItem>
                  <SelectItem value="cancelled">Cancelada</SelectItem>
                  <SelectItem value="rejected">Rejeitada</SelectItem>
                  <SelectItem value="processing">Processando</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Ambiente</Label>
              <Select value={envFilter} onValueChange={setEnvFilter}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="homologacao">Homologação</SelectItem>
                  <SelectItem value="producao">Produção</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" size="sm" onClick={() => { setStatusFilter('all'); setEnvFilter('all'); }}>
              <RefreshCw className="w-4 h-4 mr-1" /> Limpar
            </Button>
          </div>

          <Card>
            <CardContent className="p-0">
              {loadingInvoices ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : !invoices?.length ? (
                <div className="text-center py-12 text-muted-foreground">
                  <FileText className="h-12 w-12 mx-auto mb-3 opacity-30" />
                  <p>Nenhuma nota fiscal encontrada</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Número</TableHead>
                      <TableHead>Cliente</TableHead>
                      <TableHead>CFOP</TableHead>
                      <TableHead>Valor Total</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Ambiente</TableHead>
                      <TableHead>Data</TableHead>
                      <TableHead>Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoices.map(inv => (
                      <TableRow key={inv.id} className="cursor-pointer hover:bg-muted/50" onClick={() => openDetail(inv.id)}>
                        <TableCell className="font-mono font-medium">{inv.invoiceNumber || '-'}</TableCell>
                        <TableCell>
                          <div>
                            <p className="font-medium text-sm">{inv.customerName}</p>
                            <p className="text-xs text-muted-foreground">{inv.customerCnpjCpf}</p>
                          </div>
                        </TableCell>
                        <TableCell>{inv.cfop || '-'}</TableCell>
                        <TableCell className="font-medium">{formatCurrency(inv.totalInvoice || '0')}</TableCell>
                        <TableCell>{getStatusBadge(inv.status)}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={inv.environment === 'producao' ? 'border-red-300 text-red-700' : 'border-blue-300 text-blue-700'}>
                            {inv.environment === 'producao' ? 'Produção' : 'Homologação'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">{formatDate(inv.createdAt)}</TableCell>
                        <TableCell>
                          <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                            <Button variant="ghost" size="icon" title="Ver detalhes" onClick={() => openDetail(inv.id)}>
                              <Eye className="h-4 w-4" />
                            </Button>
                            {(inv.status === 'draft' || inv.status === 'rejected') && (
                              <Button variant="ghost" size="icon" title="Emitir NF-e" onClick={() => emitMutation.mutate(inv.id)} disabled={emitMutation.isPending}>
                                <Send className="h-4 w-4 text-blue-600" />
                              </Button>
                            )}
                            {inv.status === 'authorized' && (
                              <Button variant="ghost" size="icon" title="Cancelar NF-e" onClick={() => openCancel(inv.id)}>
                                <XCircle className="h-4 w-4 text-red-600" />
                              </Button>
                            )}
                            {inv.status !== 'authorized' && (
                              <Button variant="ghost" size="icon" title="Excluir NF-e" onClick={() => {
                                if (confirm('Tem certeza que deseja excluir esta NF-e?')) deleteMutation.mutate(inv.id);
                              }}>
                                <Trash2 className="h-4 w-4 text-red-500" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab: Cenários Fiscais */}
        <TabsContent value="scenarios" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Cenários Fiscais (CFOP)</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {!scenarios?.length ? (
                <div className="text-center py-8 text-muted-foreground">Nenhum cenário fiscal cadastrado</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nome</TableHead>
                      <TableHead>CFOP</TableHead>
                      <TableHead>Natureza da Operação</TableHead>
                      <TableHead>Regime Tributário</TableHead>
                      <TableHead>ICMS</TableHead>
                      <TableHead>PIS</TableHead>
                      <TableHead>COFINS</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {scenarios.map(sc => (
                      <TableRow key={sc.id}>
                        <TableCell className="font-medium">{sc.name}</TableCell>
                        <TableCell className="font-mono">{sc.cfop}</TableCell>
                        <TableCell>{sc.natureOfOperation}</TableCell>
                        <TableCell>{sc.taxRegime || '-'}</TableCell>
                        <TableCell>{sc.icmsRate ? `${sc.icmsRate}%` : '-'}</TableCell>
                        <TableCell>{sc.pisRate ? `${sc.pisRate}%` : '-'}</TableCell>
                        <TableCell>{sc.cofinsRate ? `${sc.cofinsRate}%` : '-'}</TableCell>
                        <TableCell>
                          <Badge variant={sc.isActive ? 'default' : 'secondary'} className={sc.isActive ? 'bg-green-100 text-green-800' : ''}>
                            {sc.isActive ? 'Ativo' : 'Inativo'}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab: Certificados Digitais */}
        <TabsContent value="certificates" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <ShieldCheck className="h-5 w-5" />
                Certificados Digitais
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {!certificates?.length ? (
                <div className="text-center py-8 text-muted-foreground">Nenhum certificado digital cadastrado</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Empresa</TableHead>
                      <TableHead>CNPJ</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Emissor</TableHead>
                      <TableHead>Validade</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {certificates.map(cert => (
                      <TableRow key={cert.id}>
                        <TableCell className="font-medium">{cert.companyName}</TableCell>
                        <TableCell className="font-mono text-sm">{cert.cnpj}</TableCell>
                        <TableCell>{cert.certificateType}</TableCell>
                        <TableCell>{cert.issuer || '-'}</TableCell>
                        <TableCell>
                          <div className="text-sm">
                            {cert.validFrom && <span>{formatDate(cert.validFrom)} - </span>}
                            {cert.validUntil && <span>{formatDate(cert.validUntil)}</span>}
                          </div>
                        </TableCell>
                        <TableCell>
                          {isCertificateExpired(cert.validUntil) ? (
                            <Badge variant="destructive">Expirado</Badge>
                          ) : isCertificateExpiringSoon(cert.validUntil) ? (
                            <Badge className="bg-orange-100 text-orange-800 border-orange-300">Expirando</Badge>
                          ) : cert.isActive ? (
                            <Badge className="bg-green-100 text-green-800 border-green-300">Ativo</Badge>
                          ) : (
                            <Badge variant="secondary">Inativo</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Create Invoice Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Nova Nota Fiscal Eletrônica</DialogTitle>
            <DialogDescription>Preencha os dados da NF-e. Itens podem ser adicionados abaixo.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Nome do Cliente *</Label>
                <Input value={newInvoice.customerName} onChange={e => setNewInvoice(p => ({ ...p, customerName: e.target.value }))} placeholder="Nome completo ou razão social" />
              </div>
              <div>
                <Label>CPF/CNPJ *</Label>
                <Input value={newInvoice.customerCnpjCpf} onChange={e => setNewInvoice(p => ({ ...p, customerCnpjCpf: e.target.value }))} placeholder="00.000.000/0001-00" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Cenário Fiscal</Label>
                <Select value={newInvoice.fiscalScenarioId} onValueChange={handleScenarioSelect}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione..." />
                  </SelectTrigger>
                  <SelectContent>
                    {scenarios?.filter(s => s.isActive).map(s => (
                      <SelectItem key={s.id} value={s.id}>{s.name} ({s.cfop})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>CFOP</Label>
                <Input value={newInvoice.cfop} onChange={e => setNewInvoice(p => ({ ...p, cfop: e.target.value }))} placeholder="5102" />
              </div>
            </div>
            <div>
              <Label>Natureza da Operação</Label>
              <Input value={newInvoice.natureOfOperation} onChange={e => setNewInvoice(p => ({ ...p, natureOfOperation: e.target.value }))} placeholder="Venda de mercadoria" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Forma de Pagamento</Label>
                <Select value={newInvoice.paymentMethod} onValueChange={v => setNewInvoice(p => ({ ...p, paymentMethod: v }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="a_vista">À Vista</SelectItem>
                    <SelectItem value="boleto">Boleto</SelectItem>
                    <SelectItem value="pix">PIX</SelectItem>
                    <SelectItem value="cartao_credito">Cartão de Crédito</SelectItem>
                    <SelectItem value="cartao_debito">Cartão de Débito</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Ambiente</Label>
                <Select value={newInvoice.environment} onValueChange={v => setNewInvoice(p => ({ ...p, environment: v }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="homologacao">Homologação</SelectItem>
                    <SelectItem value="producao">Produção</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Observações</Label>
              <Textarea value={newInvoice.notes} onChange={e => setNewInvoice(p => ({ ...p, notes: e.target.value }))} placeholder="Observações adicionais..." rows={2} />
            </div>

            {/* Items section */}
            <div className="border rounded-lg p-4 space-y-3">
              <h4 className="font-medium text-sm">Itens da NF-e</h4>
              {newInvoice.items.length > 0 && (
                <div className="space-y-2">
                  {newInvoice.items.map((item, idx) => (
                    <div key={idx} className="flex items-center gap-2 text-sm bg-muted/50 rounded p-2">
                      <span className="flex-1">{item.productName}</span>
                      <span className="text-muted-foreground">Qtd: {item.quantity}</span>
                      <span className="font-medium">{formatCurrency(parseFloat(item.unitPrice) * parseFloat(item.quantity))}</span>
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleRemoveItem(idx)}>
                        <Trash2 className="h-3 w-3 text-red-500" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-4 gap-2">
                <Input placeholder="Produto" value={newItem.productName} onChange={e => setNewItem(p => ({ ...p, productName: e.target.value }))} className="col-span-2" />
                <Input placeholder="Qtd" type="number" value={newItem.quantity} onChange={e => setNewItem(p => ({ ...p, quantity: e.target.value }))} />
                <Input placeholder="Preço unit." type="number" step="0.01" value={newItem.unitPrice} onChange={e => setNewItem(p => ({ ...p, unitPrice: e.target.value }))} />
              </div>
              <div className="grid grid-cols-4 gap-2">
                <Input placeholder="Código" value={newItem.productCode} onChange={e => setNewItem(p => ({ ...p, productCode: e.target.value }))} />
                <Input placeholder="NCM" value={newItem.ncm} onChange={e => setNewItem(p => ({ ...p, ncm: e.target.value }))} />
                <Input placeholder="CFOP item" value={newItem.cfop} onChange={e => setNewItem(p => ({ ...p, cfop: e.target.value }))} />
                <Button variant="outline" size="sm" onClick={handleAddItem}>
                  <Plus className="h-4 w-4 mr-1" /> Adicionar
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>Cancelar</Button>
            <Button onClick={handleCreateInvoice} disabled={createMutation.isPending} className="bg-blue-600 hover:bg-blue-700">
              {createMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Criar NF-e
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Invoice Detail Dialog */}
      <Dialog open={showDetailDialog} onOpenChange={(open) => { setShowDetailDialog(open); if (!open) setSelectedInvoiceId(null); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setShowDetailDialog(false)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              Detalhes da NF-e {invoiceDetail?.invoiceNumber ? `#${invoiceDetail.invoiceNumber}` : ''}
            </DialogTitle>
          </DialogHeader>
          {loadingDetail ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : invoiceDetail ? (
            <div className="space-y-6">
              {/* Info grid */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground">Status</p>
                  <div className="mt-1">{getStatusBadge(invoiceDetail.status)}</div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Ambiente</p>
                  <Badge variant="outline" className={invoiceDetail.environment === 'producao' ? 'border-red-300 text-red-700' : 'border-blue-300 text-blue-700'}>
                    {invoiceDetail.environment === 'producao' ? 'Produção' : 'Homologação'}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Valor Total</p>
                  <p className="text-lg font-bold">{formatCurrency(invoiceDetail.totalInvoice || '0')}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Cliente</p>
                  <p className="font-medium">{invoiceDetail.customerName}</p>
                  <p className="text-xs text-muted-foreground">{invoiceDetail.customerCnpjCpf}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">CFOP</p>
                  <p className="font-mono">{invoiceDetail.cfop || '-'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Natureza da Operação</p>
                  <p>{invoiceDetail.natureOfOperation || '-'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Pagamento</p>
                  <p>{invoiceDetail.paymentMethod || '-'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Data de Criação</p>
                  <p>{formatDateTime(invoiceDetail.createdAt)}</p>
                </div>
                {invoiceDetail.accessKey && (
                  <div className="col-span-full">
                    <p className="text-xs text-muted-foreground">Chave de Acesso</p>
                    <p className="font-mono text-xs break-all">{invoiceDetail.accessKey}</p>
                  </div>
                )}
                {invoiceDetail.protocolNumber && (
                  <div>
                    <p className="text-xs text-muted-foreground">Protocolo</p>
                    <p className="font-mono text-sm">{invoiceDetail.protocolNumber}</p>
                  </div>
                )}
              </div>

              {/* Items */}
              {invoiceDetail.items && invoiceDetail.items.length > 0 && (
                <div>
                  <h4 className="font-medium mb-2">Itens ({invoiceDetail.items.length})</h4>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>#</TableHead>
                        <TableHead>Produto</TableHead>
                        <TableHead>NCM</TableHead>
                        <TableHead>Qtd</TableHead>
                        <TableHead>Valor Unit.</TableHead>
                        <TableHead>Total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {invoiceDetail.items.map(item => (
                        <TableRow key={item.id}>
                          <TableCell>{item.itemNumber}</TableCell>
                          <TableCell>
                            <p className="font-medium text-sm">{item.productName}</p>
                            {item.productCode && <p className="text-xs text-muted-foreground">{item.productCode}</p>}
                          </TableCell>
                          <TableCell className="font-mono text-sm">{item.ncm || '-'}</TableCell>
                          <TableCell>{item.quantity}</TableCell>
                          <TableCell>{formatCurrency(item.unitPrice)}</TableCell>
                          <TableCell className="font-medium">{formatCurrency(item.totalPrice)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {/* Events Timeline */}
              {invoiceDetail.events && invoiceDetail.events.length > 0 && (
                <div>
                  <h4 className="font-medium mb-2">Histórico de Eventos</h4>
                  <div className="space-y-3">
                    {invoiceDetail.events.map(evt => (
                      <div key={evt.id} className="flex gap-3 items-start border-l-2 border-muted pl-4 pb-3">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <Badge variant={evt.status === 'success' ? 'default' : 'destructive'} className={evt.status === 'success' ? 'bg-green-100 text-green-800' : ''}>
                              {evt.eventType}
                            </Badge>
                            <span className="text-xs text-muted-foreground">{formatDateTime(evt.createdAt)}</span>
                          </div>
                          <p className="text-sm mt-1">{evt.description}</p>
                          {evt.sefazResponse && (
                            <pre className="text-xs bg-muted rounded p-2 mt-1 overflow-x-auto max-h-24">{evt.sefazResponse}</pre>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex gap-2 justify-end border-t pt-4">
                {(invoiceDetail.status === 'draft' || invoiceDetail.status === 'rejected') && (
                  <Button onClick={() => emitMutation.mutate(invoiceDetail.id)} disabled={emitMutation.isPending} className="bg-blue-600 hover:bg-blue-700">
                    {emitMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
                    Emitir NF-e
                  </Button>
                )}
                {invoiceDetail.status === 'authorized' && (
                  <Button variant="destructive" onClick={() => openCancel(invoiceDetail.id)}>
                    <XCircle className="h-4 w-4 mr-2" /> Cancelar NF-e
                  </Button>
                )}
                {invoiceDetail.status !== 'authorized' && (
                  <Button variant="outline" className="text-red-600 border-red-300" onClick={() => {
                    if (confirm('Tem certeza que deseja excluir esta NF-e?')) {
                      deleteMutation.mutate(invoiceDetail.id);
                      setShowDetailDialog(false);
                    }
                  }}>
                    <Trash2 className="h-4 w-4 mr-2" /> Excluir
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">Nota fiscal não encontrada</div>
          )}
        </DialogContent>
      </Dialog>

      {/* Cancel Dialog */}
      <Dialog open={showCancelDialog} onOpenChange={(open) => { setShowCancelDialog(open); if (!open) setCancelJustification(''); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="h-5 w-5" /> Cancelar NF-e
            </DialogTitle>
            <DialogDescription>Esta ação é irreversível. A NF-e autorizada será cancelada junto à SEFAZ.</DialogDescription>
          </DialogHeader>
          <div>
            <Label>Justificativa (mínimo 15 caracteres) *</Label>
            <Textarea
              value={cancelJustification}
              onChange={e => setCancelJustification(e.target.value)}
              placeholder="Informe o motivo do cancelamento..."
              rows={3}
            />
            <p className="text-xs text-muted-foreground mt-1">{cancelJustification.length}/15 caracteres mínimos</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCancelDialog(false)}>Voltar</Button>
            <Button
              variant="destructive"
              disabled={cancelJustification.length < 15 || cancelMutation.isPending}
              onClick={() => {
                if (selectedInvoiceId) {
                  cancelMutation.mutate({ id: selectedInvoiceId, justification: cancelJustification });
                }
              }}
            >
              {cancelMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Confirmar Cancelamento
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
