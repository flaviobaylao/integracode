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
  DollarSign, Plus, Eye, Trash2, Edit, Download, FileText, Loader2,
  Search, CreditCard, TrendingUp, TrendingDown, BarChart3, FileCode, Database,
  CheckCircle2, Clock, XCircle, AlertTriangle, Banknote
} from 'lucide-react';

const INSTANCES = [
  { value: '', label: 'Todas' },
  { value: 'BSB', label: 'BSB' },
  { value: 'GYN', label: 'GYN' },
  { value: 'IND', label: 'IND' },
  { value: 'SERV', label: 'SERV' },
];

function formatCurrency(value: string | number | null | undefined) {
  const num = typeof value === 'string' ? parseFloat(value) : (value || 0);
  if (isNaN(num)) return 'R$ 0,00';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(num);
}

function formatDate(date: string | null | undefined) {
  if (!date) return '-';
  return new Date(date).toLocaleDateString('pt-BR');
}

function getReceivableStatusBadge(status: string, dueDate?: string) {
  if (status === 'a_vencer' && dueDate && new Date(dueDate) < new Date()) {
    return <Badge className="bg-orange-100 text-orange-800 border-orange-300">Atrasada</Badge>;
  }
  const map: Record<string, { label: string; className: string }> = {
    a_vencer: { label: 'A Vencer', className: 'bg-yellow-100 text-yellow-800 border-yellow-300' },
    recebida: { label: 'Recebida', className: 'bg-green-100 text-green-800 border-green-300' },
    vencida: { label: 'Vencida', className: 'bg-red-100 text-red-800 border-red-300' },
    cancelada: { label: 'Cancelada', className: 'bg-gray-100 text-gray-800 border-gray-300' },
  };
  const cfg = map[status] || { label: status, className: '' };
  return <Badge className={cfg.className}>{cfg.label}</Badge>;
}

function getPayableStatusBadge(status: string, dueDate?: string) {
  if (status === 'a_vencer' && dueDate && new Date(dueDate) < new Date()) {
    return <Badge className="bg-orange-100 text-orange-800 border-orange-300">Atrasada</Badge>;
  }
  const map: Record<string, { label: string; className: string }> = {
    a_vencer: { label: 'A Vencer', className: 'bg-yellow-100 text-yellow-800 border-yellow-300' },
    paga: { label: 'Paga', className: 'bg-green-100 text-green-800 border-green-300' },
    vencida: { label: 'Vencida', className: 'bg-red-100 text-red-800 border-red-300' },
    cancelada: { label: 'Cancelada', className: 'bg-gray-100 text-gray-800 border-gray-300' },
  };
  const cfg = map[status] || { label: status, className: '' };
  return <Badge className={cfg.className}>{cfg.label}</Badge>;
}

function InstanceFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value || 'all'} onValueChange={(v) => onChange(v === 'all' ? '' : v)}>
      <SelectTrigger className="w-[140px]">
        <SelectValue placeholder="Instância" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">Todas</SelectItem>
        <SelectItem value="BSB">BSB</SelectItem>
        <SelectItem value="GYN">GYN</SelectItem>
        <SelectItem value="IND">IND</SelectItem>
        <SelectItem value="SERV">SERV</SelectItem>
      </SelectContent>
    </Select>
  );
}

// ============================================================================
// TAB 1: CONTAS A RECEBER
// ============================================================================
function ReceivablesTab() {
  const [instanceId, setInstanceId] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [paymentMethodFilter, setPaymentMethodFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [dueDateStart, setDueDateStart] = useState('');
  const [dueDateEnd, setDueDateEnd] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showPayment, setShowPayment] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [selectedItem, setSelectedItem] = useState<any>(null);
  const [form, setForm] = useState<any>({});
  const [paymentForm, setPaymentForm] = useState<any>({ amount: '', paymentMethod: '', financialAccountId: '', paymentDate: '', reference: '', notes: '' });

  const buildUrl = () => {
    const p = new URLSearchParams();
    if (instanceId) p.set('instanceId', instanceId);
    if (statusFilter) p.set('status', statusFilter);
    if (paymentMethodFilter) p.set('paymentMethod', paymentMethodFilter);
    if (startDate) p.set('startDate', startDate);
    if (endDate) p.set('endDate', endDate);
    if (dueDateStart) p.set('dueDateStart', dueDateStart);
    if (dueDateEnd) p.set('dueDateEnd', dueDateEnd);
    const qs = p.toString();
    return `/api/financial/receivables${qs ? `?${qs}` : ''}`;
  };

  const { data: receivables = [], isLoading } = useQuery<any[]>({
    queryKey: ['/api/financial/receivables', instanceId, statusFilter, paymentMethodFilter, startDate, endDate, dueDateStart, dueDateEnd],
    queryFn: async () => {
      const res = await fetch(buildUrl(), { credentials: 'include' });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
  });

  const { data: accounts = [] } = useQuery<any[]>({
    queryKey: ['/api/financial/accounts'],
  });

  const filtered = receivables.filter((r: any) => {
    if (customerSearch) {
      const q = customerSearch.toLowerCase();
      if (!(r.customerName || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest('POST', '/api/financial/receivables', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/financial/receivables'] });
      setShowCreate(false);
      toast({ title: 'Conta a receber criada com sucesso' });
    },
    onError: (e: any) => toast({ title: 'Erro', description: e.message, variant: 'destructive' }),
  });

  const updateMutation = useMutation({
    mutationFn: (data: any) => apiRequest('PATCH', `/api/financial/receivables/${selectedItem?.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/financial/receivables'] });
      setShowEdit(false);
      toast({ title: 'Conta a receber atualizada' });
    },
    onError: (e: any) => toast({ title: 'Erro', description: e.message, variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/financial/receivables/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/financial/receivables'] });
      toast({ title: 'Conta a receber removida' });
    },
    onError: (e: any) => toast({ title: 'Erro', description: e.message, variant: 'destructive' }),
  });

  const paymentMutation = useMutation({
    mutationFn: (data: any) => apiRequest('POST', `/api/financial/receivables/${selectedItem?.id}/payments`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/financial/receivables'] });
      setShowPayment(false);
      setPaymentForm({ amount: '', paymentMethod: '', financialAccountId: '', paymentDate: '', reference: '', notes: '' });
      toast({ title: 'Pagamento registrado com sucesso' });
    },
    onError: (e: any) => toast({ title: 'Erro', description: e.message, variant: 'destructive' }),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <Label className="text-xs">Instância</Label>
          <InstanceFilter value={instanceId} onChange={setInstanceId} />
        </div>
        <div>
          <Label className="text-xs">Cliente</Label>
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Buscar cliente..." value={customerSearch} onChange={e => setCustomerSearch(e.target.value)} className="pl-8 w-[200px]" />
          </div>
        </div>
        <div>
          <Label className="text-xs">Status</Label>
          <Select value={statusFilter || 'all'} onValueChange={v => setStatusFilter(v === 'all' ? '' : v)}>
            <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="a_vencer">A Vencer</SelectItem>
              <SelectItem value="recebida">Recebida</SelectItem>
              <SelectItem value="vencida">Vencida</SelectItem>
              <SelectItem value="cancelada">Cancelada</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Forma Pgto</Label>
          <Select value={paymentMethodFilter || 'all'} onValueChange={v => setPaymentMethodFilter(v === 'all' ? '' : v)}>
            <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              <SelectItem value="boleto">Boleto</SelectItem>
              <SelectItem value="pix">PIX</SelectItem>
              <SelectItem value="cartao">Cartão</SelectItem>
              <SelectItem value="dinheiro">Dinheiro</SelectItem>
              <SelectItem value="transferencia">Transferência</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Emissão de</Label>
          <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-[150px]" />
        </div>
        <div>
          <Label className="text-xs">Emissão até</Label>
          <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-[150px]" />
        </div>
        <div>
          <Label className="text-xs">Vencimento de</Label>
          <Input type="date" value={dueDateStart} onChange={e => setDueDateStart(e.target.value)} className="w-[150px]" />
        </div>
        <div>
          <Label className="text-xs">Vencimento até</Label>
          <Input type="date" value={dueDateEnd} onChange={e => setDueDateEnd(e.target.value)} className="w-[150px]" />
        </div>
        <Button onClick={() => { setForm({ title: '', customerName: '', description: '', amount: '', dueDate: '', paymentMethod: '', instanceId: '', chartAccountId: '' }); setShowCreate(true); }} className="ml-auto">
          <Plus className="w-4 h-4 mr-2" />Nova Conta a Receber
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-8 w-8 animate-spin" /></div>
      ) : (
        <div className="border rounded-lg overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Título</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Descrição</TableHead>
                <TableHead className="text-right">Valor</TableHead>
                <TableHead className="text-right">Valor Pago</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Vencimento</TableHead>
                <TableHead>Forma Pgto</TableHead>
                <TableHead>Instância</TableHead>
                <TableHead>Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={10} className="text-center py-8 text-muted-foreground">Nenhuma conta a receber encontrada</TableCell></TableRow>
              ) : filtered.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.title || '-'}</TableCell>
                  <TableCell>{r.customerName || '-'}</TableCell>
                  <TableCell className="max-w-[200px] truncate">{r.description || '-'}</TableCell>
                  <TableCell className="text-right font-medium">{formatCurrency(r.amount)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(r.amountPaid)}</TableCell>
                  <TableCell>{getReceivableStatusBadge(r.status, r.dueDate)}</TableCell>
                  <TableCell>{formatDate(r.dueDate)}</TableCell>
                  <TableCell>{r.paymentMethod || '-'}</TableCell>
                  <TableCell><Badge variant="outline">{r.instanceId || '-'}</Badge></TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" onClick={() => { setSelectedItem(r); setShowDetail(true); }}><Eye className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" onClick={() => { setSelectedItem(r); setPaymentForm({ amount: '', paymentMethod: '', financialAccountId: '', paymentDate: new Date().toISOString().split('T')[0], reference: '', notes: '' }); setShowPayment(true); }}><Banknote className="h-4 w-4 text-green-600" /></Button>
                      <Button variant="ghost" size="icon" onClick={() => { setSelectedItem(r); setForm({ ...r }); setShowEdit(true); }}><Edit className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" onClick={() => { if (confirm('Remover esta conta a receber?')) deleteMutation.mutate(r.id); }}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Nova Conta a Receber</DialogTitle>
            <DialogDescription>Preencha os dados da nova conta a receber</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label>Título</Label><Input value={form.title || ''} onChange={e => setForm({ ...form, title: e.target.value })} /></div>
            <div><Label>Cliente</Label><Input value={form.customerName || ''} onChange={e => setForm({ ...form, customerName: e.target.value })} /></div>
            <div><Label>Descrição</Label><Textarea value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Valor</Label><Input type="number" step="0.01" value={form.amount || ''} onChange={e => setForm({ ...form, amount: e.target.value })} /></div>
              <div><Label>Vencimento</Label><Input type="date" value={form.dueDate || ''} onChange={e => setForm({ ...form, dueDate: e.target.value })} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Forma de Pagamento</Label>
                <Select value={form.paymentMethod || 'none'} onValueChange={v => setForm({ ...form, paymentMethod: v === 'none' ? '' : v })}>
                  <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Selecione</SelectItem>
                    <SelectItem value="boleto">Boleto</SelectItem>
                    <SelectItem value="pix">PIX</SelectItem>
                    <SelectItem value="cartao">Cartão</SelectItem>
                    <SelectItem value="dinheiro">Dinheiro</SelectItem>
                    <SelectItem value="transferencia">Transferência</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Instância</Label>
                <Select value={form.instanceId || 'none'} onValueChange={v => setForm({ ...form, instanceId: v === 'none' ? '' : v })}>
                  <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Selecione</SelectItem>
                    <SelectItem value="BSB">BSB</SelectItem>
                    <SelectItem value="GYN">GYN</SelectItem>
                    <SelectItem value="IND">IND</SelectItem>
                    <SelectItem value="SERV">SERV</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancelar</Button>
            <Button onClick={() => createMutation.mutate(form)} disabled={createMutation.isPending}>
              {createMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Criar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showEdit} onOpenChange={setShowEdit}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar Conta a Receber</DialogTitle>
            <DialogDescription>Altere os dados da conta a receber</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label>Título</Label><Input value={form.title || ''} onChange={e => setForm({ ...form, title: e.target.value })} /></div>
            <div><Label>Cliente</Label><Input value={form.customerName || ''} onChange={e => setForm({ ...form, customerName: e.target.value })} /></div>
            <div><Label>Descrição</Label><Textarea value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Valor</Label><Input type="number" step="0.01" value={form.amount || ''} onChange={e => setForm({ ...form, amount: e.target.value })} /></div>
              <div><Label>Vencimento</Label><Input type="date" value={form.dueDate ? form.dueDate.split('T')[0] : ''} onChange={e => setForm({ ...form, dueDate: e.target.value })} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Forma de Pagamento</Label>
                <Select value={form.paymentMethod || 'none'} onValueChange={v => setForm({ ...form, paymentMethod: v === 'none' ? '' : v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Selecione</SelectItem>
                    <SelectItem value="boleto">Boleto</SelectItem>
                    <SelectItem value="pix">PIX</SelectItem>
                    <SelectItem value="cartao">Cartão</SelectItem>
                    <SelectItem value="dinheiro">Dinheiro</SelectItem>
                    <SelectItem value="transferencia">Transferência</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Status</Label>
                <Select value={form.status || 'a_vencer'} onValueChange={v => setForm({ ...form, status: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="a_vencer">A Vencer</SelectItem>
                    <SelectItem value="recebida">Recebida</SelectItem>
                    <SelectItem value="vencida">Vencida</SelectItem>
                    <SelectItem value="cancelada">Cancelada</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEdit(false)}>Cancelar</Button>
            <Button onClick={() => updateMutation.mutate(form)} disabled={updateMutation.isPending}>
              {updateMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showPayment} onOpenChange={setShowPayment}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Registrar Pagamento</DialogTitle>
            <DialogDescription>Registre um pagamento para: {selectedItem?.title || selectedItem?.customerName}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label>Valor</Label><Input type="number" step="0.01" value={paymentForm.amount} onChange={e => setPaymentForm({ ...paymentForm, amount: e.target.value })} placeholder="0.00" /></div>
            <div>
              <Label>Forma de Pagamento</Label>
              <Select value={paymentForm.paymentMethod || 'none'} onValueChange={v => setPaymentForm({ ...paymentForm, paymentMethod: v === 'none' ? '' : v })}>
                <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Selecione</SelectItem>
                  <SelectItem value="boleto">Boleto</SelectItem>
                  <SelectItem value="pix">PIX</SelectItem>
                  <SelectItem value="cartao">Cartão</SelectItem>
                  <SelectItem value="dinheiro">Dinheiro</SelectItem>
                  <SelectItem value="transferencia">Transferência</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Conta Financeira</Label>
              <Select value={paymentForm.financialAccountId || 'none'} onValueChange={v => setPaymentForm({ ...paymentForm, financialAccountId: v === 'none' ? '' : v })}>
                <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Selecione</SelectItem>
                  {accounts.map((a: any) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><Label>Data do Pagamento</Label><Input type="date" value={paymentForm.paymentDate} onChange={e => setPaymentForm({ ...paymentForm, paymentDate: e.target.value })} /></div>
            <div><Label>Referência</Label><Input value={paymentForm.reference} onChange={e => setPaymentForm({ ...paymentForm, reference: e.target.value })} /></div>
            <div><Label>Observações</Label><Textarea value={paymentForm.notes} onChange={e => setPaymentForm({ ...paymentForm, notes: e.target.value })} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPayment(false)}>Cancelar</Button>
            <Button onClick={() => paymentMutation.mutate(paymentForm)} disabled={paymentMutation.isPending}>
              {paymentMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Registrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDetail} onOpenChange={setShowDetail}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Detalhes - Conta a Receber</DialogTitle>
            <DialogDescription>Informações completas da conta</DialogDescription>
          </DialogHeader>
          {selectedItem && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><Label className="text-xs text-muted-foreground">Título</Label><p className="font-medium">{selectedItem.title || '-'}</p></div>
                <div><Label className="text-xs text-muted-foreground">Cliente</Label><p>{selectedItem.customerName || '-'}</p></div>
                <div><Label className="text-xs text-muted-foreground">Valor</Label><p className="font-bold text-green-700">{formatCurrency(selectedItem.amount)}</p></div>
                <div><Label className="text-xs text-muted-foreground">Valor Pago</Label><p>{formatCurrency(selectedItem.amountPaid)}</p></div>
                <div><Label className="text-xs text-muted-foreground">Status</Label><div>{getReceivableStatusBadge(selectedItem.status, selectedItem.dueDate)}</div></div>
                <div><Label className="text-xs text-muted-foreground">Vencimento</Label><p>{formatDate(selectedItem.dueDate)}</p></div>
                <div><Label className="text-xs text-muted-foreground">Forma Pgto</Label><p>{selectedItem.paymentMethod || '-'}</p></div>
                <div><Label className="text-xs text-muted-foreground">Instância</Label><p>{selectedItem.instanceId || '-'}</p></div>
              </div>
              {selectedItem.description && <div><Label className="text-xs text-muted-foreground">Descrição</Label><p className="text-sm bg-muted p-2 rounded">{selectedItem.description}</p></div>}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================================
// TAB 2: CONTAS A PAGAR
// ============================================================================
function PayablesTab() {
  const [instanceId, setInstanceId] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [dueDateStart, setDueDateStart] = useState('');
  const [dueDateEnd, setDueDateEnd] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showPayment, setShowPayment] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [selectedItem, setSelectedItem] = useState<any>(null);
  const [form, setForm] = useState<any>({});
  const [paymentForm, setPaymentForm] = useState<any>({ amount: '', paymentMethod: '', financialAccountId: '', paymentDate: '', reference: '', notes: '' });

  const buildUrl = () => {
    const p = new URLSearchParams();
    if (instanceId) p.set('instanceId', instanceId);
    if (statusFilter) p.set('status', statusFilter);
    if (sourceFilter) p.set('source', sourceFilter);
    if (startDate) p.set('startDate', startDate);
    if (endDate) p.set('endDate', endDate);
    if (dueDateStart) p.set('dueDateStart', dueDateStart);
    if (dueDateEnd) p.set('dueDateEnd', dueDateEnd);
    const qs = p.toString();
    return `/api/financial/payables${qs ? `?${qs}` : ''}`;
  };

  const { data: payables = [], isLoading } = useQuery<any[]>({
    queryKey: ['/api/financial/payables', instanceId, statusFilter, sourceFilter, startDate, endDate, dueDateStart, dueDateEnd],
    queryFn: () => fetch(buildUrl(), { credentials: 'include' }).then(r => r.json()),
  });

  const { data: accounts = [] } = useQuery<any[]>({
    queryKey: ['/api/financial/accounts'],
  });

  const filtered = payables.filter((p: any) => {
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      if (!(p.supplierName || '').toLowerCase().includes(q) && !(p.supplierDocument || '').includes(q)) return false;
    }
    return true;
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest('POST', '/api/financial/payables', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/financial/payables'] });
      setShowCreate(false);
      toast({ title: 'Conta a pagar criada com sucesso' });
    },
    onError: (e: any) => toast({ title: 'Erro', description: e.message, variant: 'destructive' }),
  });

  const updateMutation = useMutation({
    mutationFn: (data: any) => apiRequest('PATCH', `/api/financial/payables/${selectedItem?.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/financial/payables'] });
      setShowEdit(false);
      toast({ title: 'Conta a pagar atualizada' });
    },
    onError: (e: any) => toast({ title: 'Erro', description: e.message, variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/financial/payables/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/financial/payables'] });
      toast({ title: 'Conta a pagar removida' });
    },
    onError: (e: any) => toast({ title: 'Erro', description: e.message, variant: 'destructive' }),
  });

  const paymentMutation = useMutation({
    mutationFn: (data: any) => apiRequest('POST', `/api/financial/payables/${selectedItem?.id}/payments`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/financial/payables'] });
      setShowPayment(false);
      setPaymentForm({ amount: '', paymentMethod: '', financialAccountId: '', paymentDate: '', reference: '', notes: '' });
      toast({ title: 'Pagamento registrado com sucesso' });
    },
    onError: (e: any) => toast({ title: 'Erro', description: e.message, variant: 'destructive' }),
  });

  const sourceLabels: Record<string, string> = { manual: 'Manual', xml_import: 'XML Import', radar: 'Radar' };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end">
        <div><Label className="text-xs">Instância</Label><InstanceFilter value={instanceId} onChange={setInstanceId} /></div>
        <div>
          <Label className="text-xs">Fornecedor/CNPJ</Label>
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Buscar..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="pl-8 w-[200px]" />
          </div>
        </div>
        <div>
          <Label className="text-xs">Status</Label>
          <Select value={statusFilter || 'all'} onValueChange={v => setStatusFilter(v === 'all' ? '' : v)}>
            <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="a_vencer">A Vencer</SelectItem>
              <SelectItem value="paga">Paga</SelectItem>
              <SelectItem value="vencida">Vencida</SelectItem>
              <SelectItem value="cancelada">Cancelada</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Origem</Label>
          <Select value={sourceFilter || 'all'} onValueChange={v => setSourceFilter(v === 'all' ? '' : v)}>
            <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              <SelectItem value="manual">Manual</SelectItem>
              <SelectItem value="xml_import">XML Import</SelectItem>
              <SelectItem value="radar">Radar</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div><Label className="text-xs">Emissão de</Label><Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-[150px]" /></div>
        <div><Label className="text-xs">Emissão até</Label><Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-[150px]" /></div>
        <div><Label className="text-xs">Vencimento de</Label><Input type="date" value={dueDateStart} onChange={e => setDueDateStart(e.target.value)} className="w-[150px]" /></div>
        <div><Label className="text-xs">Vencimento até</Label><Input type="date" value={dueDateEnd} onChange={e => setDueDateEnd(e.target.value)} className="w-[150px]" /></div>
        <Button onClick={() => { setForm({ title: '', supplierName: '', supplierDocument: '', description: '', amount: '', dueDate: '', paymentMethod: '', instanceId: '', source: 'manual' }); setShowCreate(true); }} className="ml-auto">
          <Plus className="w-4 h-4 mr-2" />Nova Conta a Pagar
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-8 w-8 animate-spin" /></div>
      ) : (
        <div className="border rounded-lg overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Título</TableHead>
                <TableHead>Fornecedor</TableHead>
                <TableHead>CNPJ/CPF</TableHead>
                <TableHead>Descrição</TableHead>
                <TableHead className="text-right">Valor</TableHead>
                <TableHead className="text-right">Valor Pago</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Vencimento</TableHead>
                <TableHead>Origem</TableHead>
                <TableHead>Instância</TableHead>
                <TableHead>Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={11} className="text-center py-8 text-muted-foreground">Nenhuma conta a pagar encontrada</TableCell></TableRow>
              ) : filtered.map((p: any) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.title || '-'}</TableCell>
                  <TableCell>{p.supplierName || '-'}</TableCell>
                  <TableCell className="text-xs">{p.supplierDocument || '-'}</TableCell>
                  <TableCell className="max-w-[180px] truncate">{p.description || '-'}</TableCell>
                  <TableCell className="text-right font-medium">{formatCurrency(p.amount)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(p.amountPaid)}</TableCell>
                  <TableCell>{getPayableStatusBadge(p.status, p.dueDate)}</TableCell>
                  <TableCell>{formatDate(p.dueDate)}</TableCell>
                  <TableCell><Badge variant="outline">{sourceLabels[p.source] || p.source || '-'}</Badge></TableCell>
                  <TableCell><Badge variant="outline">{p.instanceId || '-'}</Badge></TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" onClick={() => { setSelectedItem(p); setShowDetail(true); }}><Eye className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" onClick={() => { setSelectedItem(p); setPaymentForm({ amount: '', paymentMethod: '', financialAccountId: '', paymentDate: new Date().toISOString().split('T')[0], reference: '', notes: '' }); setShowPayment(true); }}><Banknote className="h-4 w-4 text-green-600" /></Button>
                      <Button variant="ghost" size="icon" onClick={() => { setSelectedItem(p); setForm({ ...p }); setShowEdit(true); }}><Edit className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" onClick={() => { if (confirm('Remover esta conta a pagar?')) deleteMutation.mutate(p.id); }}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Nova Conta a Pagar</DialogTitle>
            <DialogDescription>Preencha os dados da nova conta a pagar</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label>Título</Label><Input value={form.title || ''} onChange={e => setForm({ ...form, title: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Fornecedor</Label><Input value={form.supplierName || ''} onChange={e => setForm({ ...form, supplierName: e.target.value })} /></div>
              <div><Label>CNPJ/CPF</Label><Input value={form.supplierDocument || ''} onChange={e => setForm({ ...form, supplierDocument: e.target.value })} /></div>
            </div>
            <div><Label>Descrição</Label><Textarea value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Valor</Label><Input type="number" step="0.01" value={form.amount || ''} onChange={e => setForm({ ...form, amount: e.target.value })} /></div>
              <div><Label>Vencimento</Label><Input type="date" value={form.dueDate || ''} onChange={e => setForm({ ...form, dueDate: e.target.value })} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Forma de Pagamento</Label>
                <Select value={form.paymentMethod || 'none'} onValueChange={v => setForm({ ...form, paymentMethod: v === 'none' ? '' : v })}>
                  <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Selecione</SelectItem>
                    <SelectItem value="boleto">Boleto</SelectItem>
                    <SelectItem value="pix">PIX</SelectItem>
                    <SelectItem value="cartao">Cartão</SelectItem>
                    <SelectItem value="dinheiro">Dinheiro</SelectItem>
                    <SelectItem value="transferencia">Transferência</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Instância</Label>
                <Select value={form.instanceId || 'none'} onValueChange={v => setForm({ ...form, instanceId: v === 'none' ? '' : v })}>
                  <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Selecione</SelectItem>
                    <SelectItem value="BSB">BSB</SelectItem>
                    <SelectItem value="GYN">GYN</SelectItem>
                    <SelectItem value="IND">IND</SelectItem>
                    <SelectItem value="SERV">SERV</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancelar</Button>
            <Button onClick={() => createMutation.mutate({ ...form, source: 'manual' })} disabled={createMutation.isPending}>
              {createMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Criar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showEdit} onOpenChange={setShowEdit}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar Conta a Pagar</DialogTitle>
            <DialogDescription>Altere os dados da conta a pagar</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label>Título</Label><Input value={form.title || ''} onChange={e => setForm({ ...form, title: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Fornecedor</Label><Input value={form.supplierName || ''} onChange={e => setForm({ ...form, supplierName: e.target.value })} /></div>
              <div><Label>CNPJ/CPF</Label><Input value={form.supplierDocument || ''} onChange={e => setForm({ ...form, supplierDocument: e.target.value })} /></div>
            </div>
            <div><Label>Descrição</Label><Textarea value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Valor</Label><Input type="number" step="0.01" value={form.amount || ''} onChange={e => setForm({ ...form, amount: e.target.value })} /></div>
              <div><Label>Vencimento</Label><Input type="date" value={form.dueDate ? form.dueDate.split('T')[0] : ''} onChange={e => setForm({ ...form, dueDate: e.target.value })} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Status</Label>
                <Select value={form.status || 'a_vencer'} onValueChange={v => setForm({ ...form, status: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="a_vencer">A Vencer</SelectItem>
                    <SelectItem value="paga">Paga</SelectItem>
                    <SelectItem value="vencida">Vencida</SelectItem>
                    <SelectItem value="cancelada">Cancelada</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Forma de Pagamento</Label>
                <Select value={form.paymentMethod || 'none'} onValueChange={v => setForm({ ...form, paymentMethod: v === 'none' ? '' : v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Selecione</SelectItem>
                    <SelectItem value="boleto">Boleto</SelectItem>
                    <SelectItem value="pix">PIX</SelectItem>
                    <SelectItem value="cartao">Cartão</SelectItem>
                    <SelectItem value="dinheiro">Dinheiro</SelectItem>
                    <SelectItem value="transferencia">Transferência</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEdit(false)}>Cancelar</Button>
            <Button onClick={() => updateMutation.mutate(form)} disabled={updateMutation.isPending}>
              {updateMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showPayment} onOpenChange={setShowPayment}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Registrar Pagamento</DialogTitle>
            <DialogDescription>Registre um pagamento para: {selectedItem?.title || selectedItem?.supplierName}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label>Valor</Label><Input type="number" step="0.01" value={paymentForm.amount} onChange={e => setPaymentForm({ ...paymentForm, amount: e.target.value })} placeholder="0.00" /></div>
            <div>
              <Label>Forma de Pagamento</Label>
              <Select value={paymentForm.paymentMethod || 'none'} onValueChange={v => setPaymentForm({ ...paymentForm, paymentMethod: v === 'none' ? '' : v })}>
                <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Selecione</SelectItem>
                  <SelectItem value="boleto">Boleto</SelectItem>
                  <SelectItem value="pix">PIX</SelectItem>
                  <SelectItem value="cartao">Cartão</SelectItem>
                  <SelectItem value="dinheiro">Dinheiro</SelectItem>
                  <SelectItem value="transferencia">Transferência</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Conta Financeira</Label>
              <Select value={paymentForm.financialAccountId || 'none'} onValueChange={v => setPaymentForm({ ...paymentForm, financialAccountId: v === 'none' ? '' : v })}>
                <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Selecione</SelectItem>
                  {accounts.map((a: any) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><Label>Data do Pagamento</Label><Input type="date" value={paymentForm.paymentDate} onChange={e => setPaymentForm({ ...paymentForm, paymentDate: e.target.value })} /></div>
            <div><Label>Referência</Label><Input value={paymentForm.reference} onChange={e => setPaymentForm({ ...paymentForm, reference: e.target.value })} /></div>
            <div><Label>Observações</Label><Textarea value={paymentForm.notes} onChange={e => setPaymentForm({ ...paymentForm, notes: e.target.value })} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPayment(false)}>Cancelar</Button>
            <Button onClick={() => paymentMutation.mutate(paymentForm)} disabled={paymentMutation.isPending}>
              {paymentMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Registrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDetail} onOpenChange={setShowDetail}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Detalhes - Conta a Pagar</DialogTitle>
            <DialogDescription>Informações completas da conta</DialogDescription>
          </DialogHeader>
          {selectedItem && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><Label className="text-xs text-muted-foreground">Título</Label><p className="font-medium">{selectedItem.title || '-'}</p></div>
                <div><Label className="text-xs text-muted-foreground">Fornecedor</Label><p>{selectedItem.supplierName || '-'}</p></div>
                <div><Label className="text-xs text-muted-foreground">CNPJ/CPF</Label><p>{selectedItem.supplierDocument || '-'}</p></div>
                <div><Label className="text-xs text-muted-foreground">Valor</Label><p className="font-bold text-red-700">{formatCurrency(selectedItem.amount)}</p></div>
                <div><Label className="text-xs text-muted-foreground">Valor Pago</Label><p>{formatCurrency(selectedItem.amountPaid)}</p></div>
                <div><Label className="text-xs text-muted-foreground">Status</Label><div>{getPayableStatusBadge(selectedItem.status, selectedItem.dueDate)}</div></div>
                <div><Label className="text-xs text-muted-foreground">Vencimento</Label><p>{formatDate(selectedItem.dueDate)}</p></div>
                <div><Label className="text-xs text-muted-foreground">Origem</Label><p>{sourceLabels[selectedItem.source] || selectedItem.source || '-'}</p></div>
                <div><Label className="text-xs text-muted-foreground">Instância</Label><p>{selectedItem.instanceId || '-'}</p></div>
              </div>
              {selectedItem.description && <div><Label className="text-xs text-muted-foreground">Descrição</Label><p className="text-sm bg-muted p-2 rounded">{selectedItem.description}</p></div>}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================================
// TAB 3: PLANO DE CONTAS
// ============================================================================
function ChartOfAccountsTab() {
  const [instanceId, setInstanceId] = useState('');
  const [showDialog, setShowDialog] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [form, setForm] = useState<any>({ code: '', name: '', type: 'receita', instanceId: '', isActive: true });

  const { data: accounts = [], isLoading } = useQuery<any[]>({
    queryKey: ['/api/financial/chart-of-accounts', instanceId],
    queryFn: () => fetch(`/api/financial/chart-of-accounts${instanceId ? `?instanceId=${instanceId}` : ''}`, { credentials: 'include' }).then(r => r.json()),
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest('POST', '/api/financial/chart-of-accounts', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/financial/chart-of-accounts'] });
      setShowDialog(false);
      toast({ title: 'Conta criada com sucesso' });
    },
    onError: (e: any) => toast({ title: 'Erro', description: e.message, variant: 'destructive' }),
  });

  const updateMutation = useMutation({
    mutationFn: (data: any) => apiRequest('PATCH', `/api/financial/chart-of-accounts/${editItem?.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/financial/chart-of-accounts'] });
      setShowDialog(false);
      setEditItem(null);
      toast({ title: 'Conta atualizada' });
    },
    onError: (e: any) => toast({ title: 'Erro', description: e.message, variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/financial/chart-of-accounts/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/financial/chart-of-accounts'] });
      toast({ title: 'Conta removida' });
    },
    onError: (e: any) => toast({ title: 'Erro', description: e.message, variant: 'destructive' }),
  });

  const typeBadges: Record<string, { label: string; className: string }> = {
    receita: { label: 'Receita', className: 'bg-green-100 text-green-800' },
    despesa: { label: 'Despesa', className: 'bg-red-100 text-red-800' },
    ativo: { label: 'Ativo', className: 'bg-blue-100 text-blue-800' },
    passivo: { label: 'Passivo', className: 'bg-purple-100 text-purple-800' },
  };

  const openCreate = () => { setEditItem(null); setForm({ code: '', name: '', type: 'receita', instanceId: '', isActive: true }); setShowDialog(true); };
  const openEdit = (item: any) => { setEditItem(item); setForm({ ...item }); setShowDialog(true); };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end">
        <div><Label className="text-xs">Instância</Label><InstanceFilter value={instanceId} onChange={setInstanceId} /></div>
        <Button onClick={openCreate} className="ml-auto"><Plus className="w-4 h-4 mr-2" />Nova Conta</Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-8 w-8 animate-spin" /></div>
      ) : (
        <div className="border rounded-lg overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Código</TableHead>
                <TableHead>Nome</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Nenhuma conta encontrada</TableCell></TableRow>
              ) : accounts.map((a: any) => {
                const tb = typeBadges[a.type] || { label: a.type, className: '' };
                return (
                  <TableRow key={a.id}>
                    <TableCell className="font-mono">{a.code || '-'}</TableCell>
                    <TableCell className="font-medium">{a.name}</TableCell>
                    <TableCell><Badge className={tb.className}>{tb.label}</Badge></TableCell>
                    <TableCell>{a.isActive !== false ? <Badge className="bg-green-100 text-green-800">Ativo</Badge> : <Badge variant="outline">Inativo</Badge>}</TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" onClick={() => openEdit(a)}><Edit className="h-4 w-4" /></Button>
                        <Button variant="ghost" size="icon" onClick={() => { if (confirm('Remover esta conta?')) deleteMutation.mutate(a.id); }}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editItem ? 'Editar Conta' : 'Nova Conta'}</DialogTitle>
            <DialogDescription>Preencha os dados do plano de contas</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label>Código</Label><Input value={form.code || ''} onChange={e => setForm({ ...form, code: e.target.value })} placeholder="1.1.01" /></div>
            <div><Label>Nome</Label><Input value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
            <div>
              <Label>Tipo</Label>
              <Select value={form.type || 'receita'} onValueChange={v => setForm({ ...form, type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="receita">Receita</SelectItem>
                  <SelectItem value="despesa">Despesa</SelectItem>
                  <SelectItem value="ativo">Ativo</SelectItem>
                  <SelectItem value="passivo">Passivo</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Instância</Label>
              <Select value={form.instanceId || 'none'} onValueChange={v => setForm({ ...form, instanceId: v === 'none' ? '' : v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Todas</SelectItem>
                  <SelectItem value="BSB">BSB</SelectItem>
                  <SelectItem value="GYN">GYN</SelectItem>
                  <SelectItem value="IND">IND</SelectItem>
                  <SelectItem value="SERV">SERV</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancelar</Button>
            <Button onClick={() => editItem ? updateMutation.mutate(form) : createMutation.mutate(form)} disabled={createMutation.isPending || updateMutation.isPending}>
              {(createMutation.isPending || updateMutation.isPending) && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {editItem ? 'Salvar' : 'Criar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================================
// TAB 4: CONTAS FINANCEIRAS
// ============================================================================
function FinancialAccountsTab() {
  const [instanceId, setInstanceId] = useState('');
  const [showDialog, setShowDialog] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [form, setForm] = useState<any>({ name: '', type: 'banco', bankName: '', agency: '', accountNumber: '', pixKey: '', instanceId: '', isActive: true });

  const { data: accounts = [], isLoading } = useQuery<any[]>({
    queryKey: ['/api/financial/accounts', instanceId],
    queryFn: () => fetch(`/api/financial/accounts${instanceId ? `?instanceId=${instanceId}` : ''}`, { credentials: 'include' }).then(r => r.json()),
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest('POST', '/api/financial/accounts', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/financial/accounts'] });
      setShowDialog(false);
      toast({ title: 'Conta financeira criada com sucesso' });
    },
    onError: (e: any) => toast({ title: 'Erro', description: e.message, variant: 'destructive' }),
  });

  const updateMutation = useMutation({
    mutationFn: (data: any) => apiRequest('PATCH', `/api/financial/accounts/${editItem?.id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/financial/accounts'] });
      setShowDialog(false);
      setEditItem(null);
      toast({ title: 'Conta financeira atualizada' });
    },
    onError: (e: any) => toast({ title: 'Erro', description: e.message, variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/financial/accounts/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/financial/accounts'] });
      toast({ title: 'Conta financeira removida' });
    },
    onError: (e: any) => toast({ title: 'Erro', description: e.message, variant: 'destructive' }),
  });

  const typeLabels: Record<string, string> = { caixa: 'Caixa', banco: 'Banco', carteira_digital: 'Carteira Digital' };
  const openCreate = () => { setEditItem(null); setForm({ name: '', type: 'banco', bankName: '', agency: '', accountNumber: '', pixKey: '', instanceId: '', isActive: true }); setShowDialog(true); };
  const openEdit = (item: any) => { setEditItem(item); setForm({ ...item }); setShowDialog(true); };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end">
        <div><Label className="text-xs">Instância</Label><InstanceFilter value={instanceId} onChange={setInstanceId} /></div>
        <Button onClick={openCreate} className="ml-auto"><Plus className="w-4 h-4 mr-2" />Nova Conta Financeira</Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-8 w-8 animate-spin" /></div>
      ) : (
        <div className="border rounded-lg overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Banco</TableHead>
                <TableHead>Agência</TableHead>
                <TableHead>Conta</TableHead>
                <TableHead>Chave PIX</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Nenhuma conta financeira encontrada</TableCell></TableRow>
              ) : accounts.map((a: any) => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium">{a.name}</TableCell>
                  <TableCell><Badge variant="outline">{typeLabels[a.type] || a.type}</Badge></TableCell>
                  <TableCell>{a.bankName || '-'}</TableCell>
                  <TableCell>{a.agency || '-'}</TableCell>
                  <TableCell>{a.accountNumber || '-'}</TableCell>
                  <TableCell className="text-xs max-w-[150px] truncate">{a.pixKey || '-'}</TableCell>
                  <TableCell>{a.isActive !== false ? <Badge className="bg-green-100 text-green-800">Ativo</Badge> : <Badge variant="outline">Inativo</Badge>}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" onClick={() => openEdit(a)}><Edit className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" onClick={() => { if (confirm('Remover esta conta?')) deleteMutation.mutate(a.id); }}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editItem ? 'Editar Conta Financeira' : 'Nova Conta Financeira'}</DialogTitle>
            <DialogDescription>Preencha os dados da conta financeira</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label>Nome</Label><Input value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
            <div>
              <Label>Tipo</Label>
              <Select value={form.type || 'banco'} onValueChange={v => setForm({ ...form, type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="caixa">Caixa</SelectItem>
                  <SelectItem value="banco">Banco</SelectItem>
                  <SelectItem value="carteira_digital">Carteira Digital</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Banco</Label><Input value={form.bankName || ''} onChange={e => setForm({ ...form, bankName: e.target.value })} /></div>
              <div><Label>Agência</Label><Input value={form.agency || ''} onChange={e => setForm({ ...form, agency: e.target.value })} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Conta</Label><Input value={form.accountNumber || ''} onChange={e => setForm({ ...form, accountNumber: e.target.value })} /></div>
              <div><Label>Chave PIX</Label><Input value={form.pixKey || ''} onChange={e => setForm({ ...form, pixKey: e.target.value })} /></div>
            </div>
            <div>
              <Label>Instância</Label>
              <Select value={form.instanceId || 'none'} onValueChange={v => setForm({ ...form, instanceId: v === 'none' ? '' : v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Todas</SelectItem>
                  <SelectItem value="BSB">BSB</SelectItem>
                  <SelectItem value="GYN">GYN</SelectItem>
                  <SelectItem value="IND">IND</SelectItem>
                  <SelectItem value="SERV">SERV</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancelar</Button>
            <Button onClick={() => editItem ? updateMutation.mutate(form) : createMutation.mutate(form)} disabled={createMutation.isPending || updateMutation.isPending}>
              {(createMutation.isPending || updateMutation.isPending) && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {editItem ? 'Salvar' : 'Criar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================================
// TAB 5: DRE
// ============================================================================
function DRETab() {
  const [instanceId, setInstanceId] = useState('');
  const now = new Date();
  const [startDate, setStartDate] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`);
  const [endDate, setEndDate] = useState(now.toISOString().split('T')[0]);

  const buildUrl = () => {
    const p = new URLSearchParams();
    if (instanceId) p.set('instanceId', instanceId);
    if (startDate) p.set('startDate', startDate);
    if (endDate) p.set('endDate', endDate);
    return `/api/financial/dre?${p.toString()}`;
  };

  const { data: dre, isLoading } = useQuery<any>({
    queryKey: ['/api/financial/dre', instanceId, startDate, endDate],
    queryFn: () => fetch(buildUrl(), { credentials: 'include' }).then(r => r.json()),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end">
        <div><Label className="text-xs">Instância</Label><InstanceFilter value={instanceId} onChange={setInstanceId} /></div>
        <div><Label className="text-xs">Período de</Label><Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-[160px]" /></div>
        <div><Label className="text-xs">Período até</Label><Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-[160px]" /></div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-8 w-8 animate-spin" /></div>
      ) : dre ? (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Receitas</CardTitle>
                <TrendingUp className="h-4 w-4 text-green-600" />
              </CardHeader>
              <CardContent><div className="text-2xl font-bold text-green-600">{formatCurrency(dre.summary?.totalRevenue)}</div></CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Despesas</CardTitle>
                <TrendingDown className="h-4 w-4 text-red-600" />
              </CardHeader>
              <CardContent><div className="text-2xl font-bold text-red-600">{formatCurrency(dre.summary?.totalExpenses)}</div></CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Resultado Líquido</CardTitle>
                <BarChart3 className="h-4 w-4 text-blue-600" />
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold ${(dre.summary?.netResult || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {formatCurrency(dre.summary?.netResult)}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-green-700 flex items-center gap-2"><TrendingUp className="h-5 w-5" />Receitas</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {(dre.revenue || []).map((r: any) => (
                    <div key={r.accountId} className="flex justify-between items-center py-2 border-b">
                      <div>
                        <span className="font-mono text-xs text-muted-foreground mr-2">{r.accountCode}</span>
                        <span className="text-sm">{r.accountName}</span>
                        <span className="text-xs text-muted-foreground ml-2">({r.count})</span>
                      </div>
                      <span className="font-medium text-green-700">{formatCurrency(r.total)}</span>
                    </div>
                  ))}
                  {dre.summary?.unclassifiedRevenue > 0 && (
                    <div className="flex justify-between items-center py-2 border-b border-dashed">
                      <span className="text-sm italic text-muted-foreground">Não classificadas</span>
                      <span className="font-medium text-green-600">{formatCurrency(dre.summary.unclassifiedRevenue)}</span>
                    </div>
                  )}
                  {(dre.revenue || []).length === 0 && !dre.summary?.unclassifiedRevenue && (
                    <p className="text-sm text-muted-foreground text-center py-4">Nenhuma receita no período</p>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-red-700 flex items-center gap-2"><TrendingDown className="h-5 w-5" />Despesas</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {(dre.expenses || []).map((e: any) => (
                    <div key={e.accountId} className="flex justify-between items-center py-2 border-b">
                      <div>
                        <span className="font-mono text-xs text-muted-foreground mr-2">{e.accountCode}</span>
                        <span className="text-sm">{e.accountName}</span>
                        <span className="text-xs text-muted-foreground ml-2">({e.count})</span>
                      </div>
                      <span className="font-medium text-red-700">{formatCurrency(e.total)}</span>
                    </div>
                  ))}
                  {dre.summary?.unclassifiedExpenses > 0 && (
                    <div className="flex justify-between items-center py-2 border-b border-dashed">
                      <span className="text-sm italic text-muted-foreground">Não classificadas</span>
                      <span className="font-medium text-red-600">{formatCurrency(dre.summary.unclassifiedExpenses)}</span>
                    </div>
                  )}
                  {(dre.expenses || []).length === 0 && !dre.summary?.unclassifiedExpenses && (
                    <p className="text-sm text-muted-foreground text-center py-4">Nenhuma despesa no período</p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ============================================================================
// TAB 6: XMLs
// ============================================================================
function XMLsTab() {
  const [instanceId, setInstanceId] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [accessKey, setAccessKey] = useState('');

  const buildUrl = () => {
    const p = new URLSearchParams();
    if (instanceId) p.set('instanceId', instanceId);
    if (statusFilter) p.set('status', statusFilter);
    if (startDate) p.set('startDate', startDate);
    if (endDate) p.set('endDate', endDate);
    if (customerName) p.set('customerName', customerName);
    if (accessKey) p.set('accessKey', accessKey);
    const qs = p.toString();
    return `/api/financial/xml-documents${qs ? `?${qs}` : ''}`;
  };

  const { data: documents = [], isLoading } = useQuery<any[]>({
    queryKey: ['/api/financial/xml-documents', instanceId, statusFilter, startDate, endDate, customerName, accessKey],
    queryFn: () => fetch(buildUrl(), { credentials: 'include' }).then(r => r.json()),
  });

  const handleDownload = (id: string, type: string) => {
    window.open(`/api/financial/xml-documents/${id}/download/${type}`, '_blank');
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end">
        <div><Label className="text-xs">Instância</Label><InstanceFilter value={instanceId} onChange={setInstanceId} /></div>
        <div>
          <Label className="text-xs">Status</Label>
          <Select value={statusFilter || 'all'} onValueChange={v => setStatusFilter(v === 'all' ? '' : v)}>
            <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="draft">Rascunho</SelectItem>
              <SelectItem value="authorized">Autorizada</SelectItem>
              <SelectItem value="cancelled">Cancelada</SelectItem>
              <SelectItem value="rejected">Rejeitada</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div><Label className="text-xs">Emissão de</Label><Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-[150px]" /></div>
        <div><Label className="text-xs">Emissão até</Label><Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="w-[150px]" /></div>
        <div>
          <Label className="text-xs">Cliente</Label>
          <Input placeholder="Nome do cliente" value={customerName} onChange={e => setCustomerName(e.target.value)} className="w-[180px]" />
        </div>
        <div>
          <Label className="text-xs">Chave de Acesso</Label>
          <Input placeholder="Chave de acesso" value={accessKey} onChange={e => setAccessKey(e.target.value)} className="w-[200px]" />
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-8 w-8 animate-spin" /></div>
      ) : (
        <div className="border rounded-lg overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>NF-e</TableHead>
                <TableHead>Série</TableHead>
                <TableHead>Chave de Acesso</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Emitente</TableHead>
                <TableHead className="text-right">Valor</TableHead>
                <TableHead>Emissão</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>XMLs disponíveis</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground">Nenhum documento XML encontrado</TableCell></TableRow>
              ) : documents.map((d: any) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">{d.invoiceNumber || '-'}</TableCell>
                  <TableCell>{d.series || '-'}</TableCell>
                  <TableCell className="text-xs font-mono max-w-[200px] truncate">{d.accessKey || '-'}</TableCell>
                  <TableCell>{d.customerName || '-'}</TableCell>
                  <TableCell>{d.issuerName || '-'}</TableCell>
                  <TableCell className="text-right font-medium">{formatCurrency(d.totalInvoice)}</TableCell>
                  <TableCell>{formatDate(d.emissionDate)}</TableCell>
                  <TableCell>
                    <Badge className={
                      d.status === 'authorized' ? 'bg-green-100 text-green-800' :
                      d.status === 'cancelled' ? 'bg-red-100 text-red-800' :
                      d.status === 'rejected' ? 'bg-orange-100 text-orange-800' :
                      'bg-gray-100 text-gray-800'
                    }>{d.status}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {d.hasXmlEnvio && (
                        <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => handleDownload(d.id, 'envio')}>
                          <Download className="h-3 w-3 mr-1" />Envio
                        </Button>
                      )}
                      {d.hasXmlRetorno && (
                        <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => handleDownload(d.id, 'retorno')}>
                          <Download className="h-3 w-3 mr-1" />Retorno
                        </Button>
                      )}
                      {d.hasXmlAutorizacao && (
                        <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => handleDownload(d.id, 'autorizacao')}>
                          <Download className="h-3 w-3 mr-1" />Autorização
                        </Button>
                      )}
                      {!d.hasXmlEnvio && !d.hasXmlRetorno && !d.hasXmlAutorizacao && (
                        <span className="text-xs text-muted-foreground">Nenhum</span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// TAB 7: SPED FISCAL
// ============================================================================
function SPEDTab() {
  const [instanceId, setInstanceId] = useState('');
  const [spedType, setSpedType] = useState('SPED_FISCAL');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [generateInstance, setGenerateInstance] = useState('');

  const { data: exports = [], isLoading } = useQuery<any[]>({
    queryKey: ['/api/financial/sped-exports', instanceId],
    queryFn: () => fetch(`/api/financial/sped-exports${instanceId ? `?instanceId=${instanceId}` : ''}`, { credentials: 'include' }).then(r => r.json()),
  });

  const generateMutation = useMutation({
    mutationFn: (data: any) => apiRequest('POST', '/api/financial/sped-exports/generate', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/financial/sped-exports'] });
      toast({ title: 'SPED gerado com sucesso' });
    },
    onError: (e: any) => toast({ title: 'Erro ao gerar SPED', description: e.message, variant: 'destructive' }),
  });

  const handleDownload = (id: string) => {
    window.open(`/api/financial/sped-exports/${id}/download`, '_blank');
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Database className="h-5 w-5" />Gerar SPED</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <Label className="text-xs">Tipo</Label>
              <Select value={spedType} onValueChange={setSpedType}>
                <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="SPED_FISCAL">SPED Fiscal</SelectItem>
                  <SelectItem value="BLOCO_K">Bloco K</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div><Label className="text-xs">Período de</Label><Input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} className="w-[160px]" /></div>
            <div><Label className="text-xs">Período até</Label><Input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} className="w-[160px]" /></div>
            <div>
              <Label className="text-xs">Instância</Label>
              <Select value={generateInstance || 'none'} onValueChange={v => setGenerateInstance(v === 'none' ? '' : v)}>
                <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Todas</SelectItem>
                  <SelectItem value="BSB">BSB</SelectItem>
                  <SelectItem value="GYN">GYN</SelectItem>
                  <SelectItem value="IND">IND</SelectItem>
                  <SelectItem value="SERV">SERV</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={() => generateMutation.mutate({ type: spedType, periodStart, periodEnd, omieInstanceId: generateInstance || undefined })}
              disabled={generateMutation.isPending || !periodStart || !periodEnd}
            >
              {generateMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Gerar SPED
            </Button>
          </div>
        </CardContent>
      </Card>

      <div>
        <div className="flex items-center gap-3 mb-3">
          <h3 className="font-semibold">Exportações Anteriores</h3>
          <div><InstanceFilter value={instanceId} onChange={setInstanceId} /></div>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-8 w-8 animate-spin" /></div>
        ) : (
          <div className="border rounded-lg overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Período</TableHead>
                  <TableHead>Arquivo</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Instância</TableHead>
                  <TableHead>Criado em</TableHead>
                  <TableHead>Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {exports.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Nenhuma exportação encontrada</TableCell></TableRow>
                ) : exports.map((e: any) => (
                  <TableRow key={e.id}>
                    <TableCell><Badge variant="outline">{e.type}</Badge></TableCell>
                    <TableCell>{formatDate(e.periodStart)} - {formatDate(e.periodEnd)}</TableCell>
                    <TableCell className="text-xs">{e.fileName || '-'}</TableCell>
                    <TableCell>
                      <Badge className={e.status === 'generated' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}>
                        {e.status === 'generated' ? 'Gerado' : e.status}
                      </Badge>
                    </TableCell>
                    <TableCell><Badge variant="outline">{e.omieInstanceId || 'Todas'}</Badge></TableCell>
                    <TableCell>{formatDate(e.createdAt)}</TableCell>
                    <TableCell>
                      <Button variant="outline" size="sm" onClick={() => handleDownload(e.id)}>
                        <Download className="h-4 w-4 mr-1" />Download
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// MAIN PAGE COMPONENT
// ============================================================================
export default function Financial() {
  const [activeTab, setActiveTab] = useState('receivables');

  return (
    <div className="p-6 space-y-6">
      <BackToDashboardButton />

      <div className="flex items-center gap-3">
        <DollarSign className="h-8 w-8 text-green-600" />
        <div>
          <h1 className="text-3xl font-bold">Módulo Financeiro</h1>
          <p className="text-muted-foreground">Gestão financeira completa</p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="receivables" className="gap-1"><CreditCard className="h-4 w-4" />Contas a Receber</TabsTrigger>
          <TabsTrigger value="payables" className="gap-1"><Banknote className="h-4 w-4" />Contas a Pagar</TabsTrigger>
          <TabsTrigger value="chart" className="gap-1"><BarChart3 className="h-4 w-4" />Plano de Contas</TabsTrigger>
          <TabsTrigger value="accounts" className="gap-1"><CreditCard className="h-4 w-4" />Contas Financeiras</TabsTrigger>
          <TabsTrigger value="dre" className="gap-1"><TrendingUp className="h-4 w-4" />DRE</TabsTrigger>
          <TabsTrigger value="xml" className="gap-1"><FileCode className="h-4 w-4" />XMLs</TabsTrigger>
          <TabsTrigger value="sped" className="gap-1"><Database className="h-4 w-4" />SPED Fiscal</TabsTrigger>
        </TabsList>

        <TabsContent value="receivables"><ReceivablesTab /></TabsContent>
        <TabsContent value="payables"><PayablesTab /></TabsContent>
        <TabsContent value="chart"><ChartOfAccountsTab /></TabsContent>
        <TabsContent value="accounts"><FinancialAccountsTab /></TabsContent>
        <TabsContent value="dre"><DRETab /></TabsContent>
        <TabsContent value="xml"><XMLsTab /></TabsContent>
        <TabsContent value="sped"><SPEDTab /></TabsContent>
      </Tabs>
    </div>
  );
}
