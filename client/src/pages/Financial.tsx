import { useActiveSellers, MultiSelect, multiMatch, exportToExcel, ExportExcelButton } from "@/lib/tableTools";
import ReconcileButton from "@/components/ReconcileButton";
import { useState, useEffect, useRef } from 'react';
import { generateMultiCobrancaPdf, type CobrancaData } from '@/lib/cobranca-generator';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useSearch } from 'wouter';
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
import OverdueDebtsManagement from '@/components/OverdueDebtsManagement';
import BlockedOrdersManagement from '@/components/BlockedOrdersManagement';
import { useAuth } from '@/hooks/useAuth';
import {
  DollarSign, Plus, Eye, Trash2, Edit, Download, FileText, Loader2,
  Search, CreditCard, TrendingUp, TrendingDown, BarChart3, FileCode, Database,
  CheckCircle2, Clock, XCircle, AlertTriangle, Banknote, Landmark, QrCode,
  History, ArrowUpCircle, ArrowDownCircle, Wifi, WifiOff, Copy, RefreshCw,
  Key, Ban, Camera
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

function formatDateTime(date: string | null | undefined) {
  if (!date) return '-';
  return new Date(date).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

// Vencido por DIA-CALENDÁRIO (fuso Brasil): só atrasa DEPOIS que o dia do vencimento passa.
// Vence HOJE não é atrasado (antes comparava o instante e marcava vencido no mesmo dia).
function isOverdueByDate(dueDate?: string) {
  if (!dueDate) return false;
  const opts = { timeZone: 'America/Sao_Paulo' } as const;
  return new Date(dueDate).toLocaleDateString('en-CA', opts) < new Date().toLocaleDateString('en-CA', opts);
}

function getReceivableStatusBadge(status: string, dueDate?: string) {
  if (status === 'a_vencer' && isOverdueByDate(dueDate)) {
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
  if (status === 'a_vencer' && isOverdueByDate(dueDate)) {
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
function useInstanceNames(): Record<string, string> {
  const { data } = useQuery<any[]>({
    queryKey: ['/api/omie/instances'],
    queryFn: () => fetch('/api/omie/instances', { credentials: 'include' }).then(r => r.json()).catch(() => []),
  });
  const map: Record<string, string> = {};
  (Array.isArray(data) ? data : []).forEach((i) => { if (i?.id) map[i.id] = i.displayName || i.name || i.id; });
  return map;
}

// FASE 2 - Badges de lancamento: DRE (conta gerencial), Fluxo (conta financeira) e
// Conciliada (origem: webhook/baixa automatica BB em esmeralda; extrato/manual em verde).
function LancamentoBadges({ item }: { item: any }) {
  const b = item?.badges;
  if (!b) return null;
  return (
    <div className="flex gap-1 flex-wrap">
      {b.dre && <Badge variant="outline" className="border-purple-400 text-purple-700 px-1.5 py-0" title="Classificada no plano de contas — entra na DRE">DRE</Badge>}
      {b.fluxo && <Badge variant="outline" className="border-blue-400 text-blue-700 px-1.5 py-0" title="Vinculada a conta financeira — entra no fluxo de caixa">Fluxo</Badge>}
      {b.conciliada && (b.origem === 'webhook'
        ? <Badge className="bg-emerald-600 hover:bg-emerald-600 text-white px-1.5 py-0" title="Conciliada automaticamente pelo BB (webhook/consulta)">Conciliada</Badge>
        : <Badge className="bg-green-500 hover:bg-green-500 text-white px-1.5 py-0" title="Conciliada via extrato bancario (OFX)">Conciliada</Badge>)}
      {b.baixado && <Badge className="bg-slate-400 hover:bg-slate-400 text-white px-1.5 py-0" title="Baixa manual (marcada como paga) — ainda NÃO conciliada no extrato bancário">Baixado</Badge>}
    </div>
  );
}

// FASE 2 - PIX recebidos pelo webhook do BB sem cobranca correspondente no sistema.
function PixNaoIdentificadosTab() {
  const [statusFilter, setStatusFilter] = useState('pendente');
  const { data: items = [], isLoading, refetch } = useQuery<any[]>({
    queryKey: ['/api/financial/pix-nao-identificados', statusFilter],
    queryFn: async () => {
      const res = await fetch(`/api/financial/pix-nao-identificados?status=${statusFilter}`, { credentials: 'include' });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
  });
  const mudarStatus = useMutation({
    mutationFn: ({ id, status }: any) => apiRequest('POST', `/api/financial/pix-nao-identificados/${id}/status`, { status }),
    onSuccess: () => refetch(),
  });
  const fmtBRL = (v: any) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v || 0));
  return (
    <Card>
      <CardHeader>
        <CardTitle>PIX recebidos sem identificação</CardTitle>
        <p className="text-sm text-muted-foreground">PIX notificados pelo BB que não casaram com nenhuma cobrança do sistema. A baixa continua sendo feita na Conciliação (extrato OFX) — use esta lista para investigar e marcar como tratado.</p>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2 mb-3">
          {['pendente', 'resolvido', 'ignorado', 'todos'].map(s => (
            <Button key={s} size="sm" variant={statusFilter === s ? 'default' : 'outline'} onClick={() => setStatusFilter(s)}>{s}</Button>
          ))}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Recebido em</TableHead>
              <TableHead className="text-right">Valor</TableHead>
              <TableHead>Pagador</TableHead>
              <TableHead>txid / e2e</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (<TableRow><TableCell colSpan={6} className="text-center py-8">Carregando...</TableCell></TableRow>) : items.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Nenhum PIX não identificado</TableCell></TableRow>
            ) : items.map((p: any) => (
              <TableRow key={p.id}>
                <TableCell>{p.horario ? new Date(p.horario).toLocaleString('pt-BR') : (p.created_at ? new Date(p.created_at).toLocaleString('pt-BR') : '-')}</TableCell>
                <TableCell className="text-right font-medium">{fmtBRL(p.valor)}</TableCell>
                <TableCell className="max-w-[220px] truncate">{p.info_pagador || '-'}</TableCell>
                <TableCell className="text-xs max-w-[260px] truncate">{p.txid || '-'}{p.end_to_end_id ? ' / ' + p.end_to_end_id : ''}</TableCell>
                <TableCell><Badge variant={p.status === 'pendente' ? 'destructive' : 'outline'}>{p.status}</Badge></TableCell>
                <TableCell>
                  {p.status === 'pendente' && (<div className="flex gap-1">
                    <Button size="sm" variant="outline" onClick={() => mudarStatus.mutate({ id: p.id, status: 'resolvido' })}>Resolvido</Button>
                    <Button size="sm" variant="ghost" onClick={() => mudarStatus.mutate({ id: p.id, status: 'ignorado' })}>Ignorar</Button>
                  </div>)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// FASE 3.1 - Tela de revisao: fornecedores sem conta gerencial. Classificar cria uma
// regra (fornecedor -> conta) aplicada aos titulos atuais e aos futuros do fornecedor.
function ClassificacaoTab() {
  const { data: pendentes = [], isLoading, refetch } = useQuery<any[]>({
    queryKey: ['/api/financial/payables-unclassified'],
    queryFn: async () => { const r = await fetch('/api/financial/payables-unclassified', { credentials: 'include' }); if (!r.ok) return []; const d = await r.json(); return Array.isArray(d) ? d : []; },
  });
  const { data: contas = [] } = useQuery<any[]>({
    queryKey: ['/api/financial/chart-of-accounts', 'children'],
    queryFn: async () => { const r = await fetch('/api/financial/chart-of-accounts', { credentials: 'include' }); if (!r.ok) return []; const d = await r.json(); return (Array.isArray(d) ? d : []).filter((a: any) => String(a.code).includes('.') && a.isActive !== false).sort((a: any, b: any) => String(a.code).localeCompare(String(b.code))); },
  });
  const [sel, setSel] = useState<Record<string, string>>({});
  const classificar = useMutation({
    mutationFn: ({ pattern, chartAccountId }: any) => apiRequest('POST', '/api/financial/payable-rules', { pattern, chartAccountId }),
    onSuccess: () => { refetch(); },
  });
  const fmtBRL = (v: any) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v || 0));
  const totalPend = pendentes.reduce((s: number, p: any) => s + Number(p.valor || 0), 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Classificação DRE — contas a pagar pendentes</CardTitle>
        <p className="text-sm text-muted-foreground">Escolha a conta gerencial de cada fornecedor e clique em Classificar. A escolha vira regra: classifica os títulos atuais e os futuros do fornecedor automaticamente. Pendentes: {pendentes.length} fornecedores, {fmtBRL(totalPend)}.</p>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fornecedor</TableHead>
              <TableHead className="text-right">Títulos</TableHead>
              <TableHead className="text-right">Valor</TableHead>
              <TableHead>Conta gerencial</TableHead>
              <TableHead>Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (<TableRow><TableCell colSpan={5} className="text-center py-8">Carregando...</TableCell></TableRow>) : pendentes.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Tudo classificado</TableCell></TableRow>
            ) : pendentes.slice(0, 100).map((p: any) => (
              <TableRow key={p.fornecedor}>
                <TableCell className="max-w-[280px] truncate font-medium" title={p.exemplo || ''}>{p.fornecedor}</TableCell>
                <TableCell className="text-right">{p.titulos}</TableCell>
                <TableCell className="text-right">{fmtBRL(p.valor)}</TableCell>
                <TableCell>
                  <Select value={sel[p.fornecedor] || ''} onValueChange={(v) => setSel({ ...sel, [p.fornecedor]: v })}>
                    <SelectTrigger className="w-[300px]"><SelectValue placeholder="Selecione a conta" /></SelectTrigger>
                    <SelectContent>
                      {contas.map((c: any) => (<SelectItem key={c.id} value={c.id}>{c.code} — {c.name}</SelectItem>))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <Button size="sm" disabled={!sel[p.fornecedor] || classificar.isPending} onClick={() => classificar.mutate({ pattern: p.fornecedor, chartAccountId: sel[p.fornecedor] })}>Classificar</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ReceivablesTab({ readOnly = false, canBoleto = false }: { readOnly?: boolean; canBoleto?: boolean } = {}) {
  const [instanceId, setInstanceId] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [paymentMethodFilter, setPaymentMethodFilter] = useState('');
  const [sellerMulti, setSellerMulti] = useState<string[]>([]);
  const [valueMin, setValueMin] = useState('');
  const [valueMax, setValueMax] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [dueDateStart, setDueDateStart] = useState('');
  const [dueDateEnd, setDueDateEnd] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showPayment, setShowPayment] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [showPhotos, setShowPhotos] = useState(false); // comprovante de entrega (fotos do entregador)
  const [photosItem, setPhotosItem] = useState<any>(null);
  const [selectedItem, setSelectedItem] = useState<any>(null);
  const [form, setForm] = useState<any>({});
  const [paymentForm, setPaymentForm] = useState<any>({ amount: '', paymentMethod: '', financialAccountId: '', paymentDate: '', reference: '', notes: '' });
  const [custSug, setCustSug] = useState<any[]>([]);
  const custTimer = useRef<any>(null);
  const buscarClientes = (v: string) => {
    if (custTimer.current) clearTimeout(custTimer.current);
    const q = (v || '').trim();
    if (q.length < 2) { setCustSug([]); return; }
    custTimer.current = setTimeout(async () => {
      try {
        const r = await fetch('/api/reconciliation/customers/search?q=' + encodeURIComponent(q), { credentials: 'include' });
        const j = await r.json();
        setCustSug(Array.isArray(j.customers) ? j.customers : []);
      } catch { setCustSug([]); }
    }, 250);
  };
  const pickCliente = (c: any) => {
    setForm((f: any) => ({ ...f, customerName: c.name || c.company_name || '', customerId: c.id || f.customerId, customerDocument: c.cnpj || c.cpf || f.customerDocument || '' }));
    setCustSug([]);
  };

  // Abre SEM filtro do usuario -> modo paginado rapido (1a pagina + resumo do servidor).
  // Assim que qualquer filtro do cliente e usado, busca o conjunto completo (filtra no cliente).
  const noClientFilters = sellerMulti.length === 0 && !customerSearch && valueMin === '' && valueMax === '';
  const [unifySel, setUnifySel] = useState<string[]>([]);
  const [unifyBusy, setUnifyBusy] = useState(false);
  const [unifyDate, setUnifyDate] = useState('');
  const toggleUnify = (id: string) => setUnifySel((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  // Pre-preenche o vencimento do boleto unificado com o vencimento MAIS PROXIMO dos titulos
  // selecionados (editavel pelo usuario). Zera ao limpar a selecao.
  useEffect(() => {
    if (unifySel.length > 0 && !unifyDate) {
      const ds = receivables.filter((r: any) => unifySel.includes(r.id)).map((r: any) => r.dueDate).filter(Boolean).map((d: any) => new Date(d)).sort((a: any, b: any) => a.getTime() - b.getTime());
      if (ds[0]) { const d: Date = ds[0]; setUnifyDate(new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)); }
    }
    if (unifySel.length === 0 && unifyDate) setUnifyDate('');
  }, [unifySel]);
  const emitirCobrancaUnificada = async () => {
    if (unifySel.length < 2) { alert('Selecione ao menos 2 títulos do mesmo cliente.'); return; }
    if (!unifyDate) { alert('Escolha a data de vencimento do boleto.'); return; }
    if (!confirm(`Gerar UM boleto único juntando ${unifySel.length} títulos, com vencimento em ${new Date(unifyDate + 'T12:00:00').toLocaleDateString('pt-BR')}?\n\nAs cobranças anteriores desses títulos (boletos/PIX ainda em aberto) serão canceladas automaticamente.\n\nQuando esse boleto for pago, TODOS os títulos serão baixados automaticamente.`)) return;
    setUnifyBusy(true);
    try {
      const res = await fetch('/api/financial/boleto/combined', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ receivableIds: unifySel, dueDate: unifyDate }) });
      const j = await res.json();
      if (!res.ok || !(j.success || j.ok)) { alert('Não foi possível unir os títulos: ' + (j.error || j.persistError || 'erro')); return; }
      setUnifySel([]); setUnifyDate('');
      queryClient.invalidateQueries({ queryKey: ['/api/financial/receivables'] });
      if (j.viewUrl) window.open(j.viewUrl, '_blank');
      const c = j.cancelamentos || {};
      const canceladas = (c.boletos || 0) + (c.combinados || 0) + (c.pix || 0);
      alert('Boleto unificado gerado com sucesso.' + (canceladas > 0 ? `\n\n${canceladas} cobrança(s) anterior(es) cancelada(s) automaticamente.` : ''));
    } catch (e: any) { alert('Erro: ' + (e?.message || e)); }
    finally { setUnifyBusy(false); }
  };
  const buildUrl = () => {
    const p = new URLSearchParams();
    if (instanceId) p.set('instanceId', instanceId);
    if (statusFilter) p.set('status', statusFilter);
    if (paymentMethodFilter) p.set('paymentMethod', paymentMethodFilter);
    if (startDate) p.set('startDate', startDate);
    if (endDate) p.set('endDate', endDate);
    if (dueDateStart) p.set('dueDateStart', dueDateStart);
    if (dueDateEnd) p.set('dueDateEnd', dueDateEnd);
    if (noClientFilters) { p.set('paged', '1'); p.set('limit', '300'); }
    const qs = p.toString();
    return `/api/financial/receivables${qs ? `?${qs}` : ''}`;
  };

  const instanceNames = useInstanceNames();
  const { data: recData, isLoading } = useQuery<any>({
    queryKey: ['/api/financial/receivables', instanceId, statusFilter, paymentMethodFilter, startDate, endDate, dueDateStart, dueDateEnd, noClientFilters],
    queryFn: async () => {
      const res = await fetch(buildUrl(), { credentials: 'include' });
      if (!res.ok) return { rows: [], total: null, summary: null };
      const data = await res.json();
      if (data && !Array.isArray(data) && Array.isArray(data.rows)) return data;
      return { rows: Array.isArray(data) ? data : [], total: null, summary: null };
    },
  });
  const receivables: any[] = recData?.rows || [];
  const serverSummary: any = recData?.summary || null;
  const serverTotal: number | null = recData?.total ?? null;

  const { data: accounts = [] } = useQuery<any[]>({
    queryKey: ['/api/financial/accounts'],
  });

  const { sellerOptions, sellerGroups, resolveSeller } = useActiveSellers();
  const [sortAZ, setSortAZ] = useState(false);
  const filtered = receivables.filter((r: any) => {
    if (!multiMatch(sellerMulti, resolveSeller(r.sellerName))) return false;
    if (customerSearch) {
      const q = customerSearch.toLowerCase();
      // Busca por CLIENTE ou NF (numero da nota / titulo). Aceita "104371" ou "NF-104371".
      const hay = `${r.customerName || ''} ${r.titleNumber || ''} ${r.invoiceNumber || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (valueMin !== '' && Number(r.amount || 0) < parseFloat(String(valueMin).replace(',', '.'))) return false;
    if (valueMax !== '' && Number(r.amount || 0) > parseFloat(String(valueMax).replace(',', '.'))) return false;
    return true;
  });
  if (sortAZ) filtered.sort((a: any, b: any) => String(a.customerName || '').localeCompare(String(b.customerName || '')));

  // Totais: no modo paginado usa o RESUMO do servidor (sobre todas as contas); com filtro
  // do cliente ativo, soma sobre o conjunto completo carregado (filtered).
  const dispCount = serverSummary ? serverSummary.count : filtered.length;
  const dispAmount = serverSummary ? serverSummary.amount : filtered.reduce((s: number, r: any) => s + (Number(r.amount) || 0), 0);
  const dispPaid = serverSummary ? serverSummary.paid : filtered.reduce((s: number, r: any) => s + (Number(r.amountPaid) || 0), 0);
  const dispSaldo = serverSummary ? serverSummary.saldo : filtered.reduce((s: number, r: any) => s + ((Number(r.amount) || 0) - (Number(r.amountPaid) || 0)), 0);
  const dispShownOf = serverTotal ?? filtered.length;

  // Emite o DOCUMENTO de cobrança (boleto/PIX) em PDF, idêntico ao do pipeline de faturamento.
  const emitirCobranca = async (r: any) => {
    try {
      const load = async () => { const rp = await fetch(`/api/financial/receivables/${r.id}/cobranca`, { credentials: 'include' }); return rp.json(); };
      let c = await load();
      if (c.hasCharge && c.dueDateChanged) {
        const fmt = (d: any) => d ? new Date(d).toLocaleDateString('pt-BR') : '?';
        if (confirm('O vencimento da cobrança mudou (cobrança ' + fmt(c.chargeDueDate) + ' → conta ' + fmt(c.receivableDueDate) + ').\n\nGerar NOVA cobrança com o novo vencimento e CANCELAR a anterior no banco?')) {
          const rg = await fetch('/api/financial/receivables/' + r.id + '/regenerate-charge', { method: 'POST', credentials: 'include' });
          const jr = await rg.json();
          if (!(jr.success || jr.ok)) { alert('Falha ao regerar cobrança: ' + (jr.error || jr.persistError || 'erro')); return; }
          c = await load();
        }
      }
      if (!c.hasCharge) {
        if (!confirm('Nenhuma cobrança vinculada a esta conta. Emitir um boleto (com PIX) agora?')) return;
        const em = await fetch(`/api/financial/receivables/${r.id}/emit-boleto`, { method: 'POST', credentials: 'include' });
        const j = await em.json();
        if (!(j.success || j.ok)) { alert('Falha ao emitir cobrança: ' + (j.error || j.persistError || 'erro')); return; }
        c = await load();
      }
      if (!c.hasCharge || (!c.boleto && !c.pix)) { alert('Cobrança não encontrada.'); return; }
      const data: CobrancaData = { itemId: r.id, customerName: c.customerName || r.customerName, invoiceNumber: r.titleNumber, saleValue: c.amount || r.amount, boleto: c.boleto || null, pix: c.pix || null };
      const n = await generateMultiCobrancaPdf([data]);
      if (n === 0) alert('Cobrança sem boleto/PIX para gerar.');
    } catch (e: any) { alert('Erro: ' + (e?.message || e)); }
  };

  // Troca a cobrança ATIVA (PIX ou boleto) por um BOLETO novo: cancela a atual no
  // banco e registra um boleto. Resolve o caso "faturou em PIX mas deveria ser boleto".
  const trocarParaBoleto = async (r: any) => {
    if (!confirm(`Trocar a cobrança de "${r.titleNumber || r.customerName}" para BOLETO?\n\nA cobrança atual (PIX ou boleto) será CANCELADA no banco e um novo BOLETO será gerado.`)) return;
    try {
      const rg = await fetch(`/api/financial/receivables/${r.id}/regenerate-charge`, { method: 'POST', credentials: 'include' });
      const jr = await rg.json();
      if (!(jr.success || jr.ok)) { alert('Falha ao gerar boleto: ' + (jr.error || jr.persistError || 'erro')); return; }
      alert('Boleto gerado com sucesso.' + (jr.canceladoAnterior ? '\n\nA cobrança anterior (PIX/boleto) foi cancelada no banco.' : ''));
      queryClient.invalidateQueries({ queryKey: ['/api/financial/receivables'] });
    } catch (e: any) { alert('Erro ao gerar boleto: ' + (e?.message || e)); }
  };

  // BAIXA ADMINISTRATIVA (100%): fecha o título SEM entrada de dinheiro (perdão /
  // incobrável). Exige MOTIVO (obrigatório) e registra quem executou (backend grava
  // updated_by + auditoria financeira). Não conta como recebimento no caixa.
  const baixaAdministrativa = async (r: any) => {
    const saldo = Math.max(0, (Number(r.amount || 0) - Number(r.amountPaid || 0)));
    const motivo = window.prompt(`BAIXA ADMINISTRATIVA (100%) do título "${r.titleNumber || r.customerName}" — saldo ${formatCurrency(saldo)}.\n\nFecha o título SEM entrada de dinheiro (perdão / incobrável) e fica registrado com o seu usuário.\n\nDigite o MOTIVO (obrigatório):`);
    if (motivo === null) return;
    if (!motivo.trim()) { alert('O motivo é obrigatório para a baixa administrativa.'); return; }
    if (!confirm(`Confirmar baixa administrativa de ${formatCurrency(saldo)} no título "${r.titleNumber || r.customerName}"?\n\nMotivo: ${motivo.trim()}\n\nEssa ação FECHA o título e NÃO conta como recebimento.`)) return;
    try {
      const rr = await fetch(`/api/financial/receivables/${r.id}/write-off`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ reason: motivo.trim() }) });
      const j = await rr.json();
      if (!(j.ok || j.success)) { alert('Falha na baixa: ' + (j.message || j.error || 'erro')); return; }
      alert('Baixa administrativa registrada com sucesso.');
      queryClient.invalidateQueries({ queryKey: ['/api/financial/receivables'] });
    } catch (e: any) { alert('Erro ao dar baixa: ' + (e?.message || e)); }
  };

  // FASE 3.4e - categorias analiticas do DRE p/ o campo obrigatorio do formulario
  const { data: dreAccounts = [] } = useQuery<any[]>({
    queryKey: ['/api/financial/chart-of-accounts', 'dre-recv'],
    queryFn: async () => { const r = await fetch('/api/financial/chart-of-accounts', { credentials: 'include' }); if (!r.ok) return []; const d = await r.json(); return (Array.isArray(d) ? d : []).filter((a: any) => String(a.code).includes('.') && a.isActive !== false).sort((a: any, b: any) => String(a.code).localeCompare(String(b.code))); },
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

  // Histórico completo da conta (cobrança, documento, recebimentos, baixas, conciliações) — carregado ao abrir o detalhe.
  const { data: history, isLoading: historyLoading } = useQuery<any>({
    queryKey: ['/api/financial/receivables', selectedItem?.id, 'history'],
    enabled: showDetail && !!selectedItem?.id,
    queryFn: async () => {
      const res = await fetch(`/api/financial/receivables/${selectedItem?.id}/history`, { credentials: 'include' });
      if (!res.ok) return null;
      return res.json();
    },
  });

  return (
    <div className="space-y-4">
      {!readOnly && <ReconcileButton table="receivables" />}
      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <Label className="text-xs">Instância</Label>
          <InstanceFilter value={instanceId} onChange={setInstanceId} />
        </div>
        <div>
          <Label className="text-xs">Cliente</Label>
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Buscar cliente ou NF..." value={customerSearch} onChange={e => setCustomerSearch(e.target.value)} className="pl-8 w-[220px]" />
          </div>
        </div>
        <div>
          <Label className="text-xs">Valor (R$)</Label>
          <div className="flex gap-1 items-center">
            <Input type="number" step="0.01" placeholder="mín." value={valueMin} onChange={e => setValueMin(e.target.value)} className="w-[90px]" data-testid="filter-valuemin-receivables" />
            <span className="text-xs text-muted-foreground">até</span>
            <Input type="number" step="0.01" placeholder="máx." value={valueMax} onChange={e => setValueMax(e.target.value)} className="w-[90px]" data-testid="filter-valuemax-receivables" />
          </div>
        </div>
          <div>
            <Label className="text-xs">Vendedor</Label>
            <div><MultiSelect label="Vendedor" options={sellerOptions} groups={sellerGroups} selected={sellerMulti} onChange={setSellerMulti} testId="filter-seller-receivables" /></div>
          </div>
          <div className="flex gap-2 items-end">
            <Button type="button" variant="outline" size="sm" onClick={() => setSortAZ(!sortAZ)} data-testid="sort-az-receivables">{sortAZ ? "Cliente A-Z: ligado" : "Ordenar A-Z"}</Button>
            <ExportExcelButton testId="export-receivables" onClick={() => exportToExcel(filtered.map((r: any) => ({ Titulo: r.titleNumber, Cliente: r.customerName, Vendedor: resolveSeller(r.sellerName), Categoria: r.category, Descricao: r.description, Valor: Number(r.amount || 0), ValorPago: Number(r.amountPaid || 0), Status: r.status, Vencimento: r.dueDate ? new Date(r.dueDate).toLocaleDateString("pt-BR") : "" })), "contas-a-receber")} />
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
{!readOnly && (
        <Button onClick={() => { setForm({ title: '', customerName: '', description: '', amount: '', dueDate: '', paymentMethod: '', instanceId: '', chartAccountId: '' }); setShowCreate(true); }} className="ml-auto">
          <Plus className="w-4 h-4 mr-2" />Nova Conta a Receber
        </Button>
        )}
      </div>

      {(canBoleto || !readOnly) && unifySel.length > 0 && (
        <div className="flex items-center gap-3 mb-3 p-3 rounded-lg bg-blue-50 border border-blue-200">
          <span className="text-sm font-medium text-blue-900">{unifySel.length} título(s) selecionado(s) — gere um único boleto que, ao ser pago, baixa todos.</span>
          <label className="text-sm text-blue-900 flex items-center gap-1 ml-auto whitespace-nowrap">Vencimento:
            <input type="date" value={unifyDate} onChange={(e) => setUnifyDate(e.target.value)} className="border rounded px-2 py-1 text-sm" />
          </label>
          <Button size="sm" onClick={emitirCobrancaUnificada} disabled={unifyBusy || unifySel.length < 2 || !unifyDate}>{unifyBusy ? 'Gerando…' : 'Unir em um boleto'}</Button>
          <Button size="sm" variant="outline" onClick={() => { setUnifySel([]); setUnifyDate(''); }}>Limpar</Button>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-8 w-8 animate-spin" /></div>
      ) : (
        <div className="border rounded-lg overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Título</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Vendedor</TableHead>
                <TableHead>Categoria</TableHead>
                <TableHead>Descrição</TableHead>
                <TableHead className="text-right">Valor</TableHead>
                <TableHead className="text-right">Valor Pago</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Lançamento</TableHead>
                <TableHead>Vencimento</TableHead>
                <TableHead>Forma Pgto</TableHead>
                <TableHead>Instância</TableHead>
                <TableHead>Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={13} className="text-center py-8 text-muted-foreground">Nenhuma conta a receber encontrada</TableCell></TableRow>
              ) : filtered.slice(0, 300).map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.titleNumber || '-'}</TableCell>
                  <TableCell>{r.customerName || '-'}</TableCell>
                  <TableCell>{r.sellerName || '-'}</TableCell>
                  <TableCell className="max-w-[160px] truncate">{r.category || '-'}</TableCell>
                  <TableCell className="max-w-[200px] truncate">{r.description || '-'}</TableCell>
                  <TableCell className="text-right font-medium">{formatCurrency(r.amount)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(r.amountPaid)}</TableCell>
                  <TableCell>{getReceivableStatusBadge(r.status, r.dueDate)}{String(r.notes || '').includes('BAIXA ADMINISTRATIVA') && (<Badge variant="outline" className="ml-1 border-rose-400 text-rose-700 px-1.5 py-0" title="Baixa administrativa (perdão/incobrável)">Baixa adm.</Badge>)}</TableCell>
                  <TableCell><LancamentoBadges item={r} /></TableCell>
                  <TableCell>{formatDate(r.dueDate)}</TableCell>
                  <TableCell>{r.paymentMethod || '-'}</TableCell>
                  <TableCell><Badge variant="outline">{instanceNames[r.omieInstanceId] || r.omieInstanceId || '-'}</Badge></TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {(canBoleto || !readOnly) && ['a_vencer', 'vencida'].includes(String(r.status)) && (<input type="checkbox" title="Selecionar p/ boleto unificado" className="mr-1 h-4 w-4 self-center cursor-pointer" checked={unifySel.includes(r.id)} onChange={() => toggleUnify(r.id)} />)}
                      <Button variant="ghost" size="icon" onClick={() => { setSelectedItem(r); setShowDetail(true); }}><Eye className="h-4 w-4" /></Button>
                      {r.deliveryPhotos?.length ? (<Button variant="ghost" size="icon" title="Comprovante de entrega (foto do entregador)" onClick={() => { setPhotosItem(r); setShowPhotos(true); }}><Camera className="h-4 w-4 text-emerald-600" /></Button>) : null}
                      {(!readOnly || canBoleto) && (<Button variant="ghost" size="icon" title="Boleto bancário / PIX" onClick={() => emitirCobranca(r)}><QrCode className="h-4 w-4 text-blue-600" /></Button>)}
                      {(!readOnly || canBoleto) && ['a_vencer', 'vencida'].includes(String(r.status)) && (<Button variant="ghost" size="icon" title="Gerar boleto (trocar cobrança) — cancela o PIX/boleto atual e emite um boleto novo" onClick={() => trocarParaBoleto(r)}><Landmark className="h-4 w-4 text-amber-600" /></Button>)}
                      {!readOnly && ['a_vencer', 'vencida'].includes(String(r.status)) && (<Button variant="ghost" size="icon" title="Baixa administrativa 100% (perdão/incobrável — exige motivo; NÃO conta como recebimento)" onClick={() => baixaAdministrativa(r)}><Ban className="h-4 w-4 text-rose-600" /></Button>)}
                      {!readOnly && (<><Button variant="ghost" size="icon" onClick={() => { setSelectedItem(r); setPaymentForm({ amount: '', paymentMethod: '', financialAccountId: '', paymentDate: new Date().toISOString().split('T')[0], reference: '', notes: '' }); setShowPayment(true); }}><Banknote className="h-4 w-4 text-green-600" /></Button>
                      <Button variant="ghost" size="icon" onClick={() => { setSelectedItem(r); setForm({ ...r }); setShowEdit(true); }}><Edit className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" onClick={() => { if (confirm('Remover esta conta a receber?')) deleteMutation.mutate(r.id); }}><Trash2 className="h-4 w-4 text-red-500" /></Button></>)}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {dispShownOf > 300 && (<TableRow><TableCell colSpan={13} className="text-center py-3 text-amber-700 bg-amber-50">Mostrando as primeiras 300 de {dispShownOf} contas — refine por status, período, vendedor ou busca. O total abaixo considera todas as {dispShownOf} contas.</TableCell></TableRow>)}
                  {(filtered.length > 0 || dispCount > 0) && (
                <TableRow className="bg-muted/50 font-semibold border-t-2">
                  <TableCell colSpan={5}>Total ({dispCount} {dispCount === 1 ? 'conta' : 'contas'})</TableCell>
                  <TableCell className="text-right">{formatCurrency(dispAmount)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(dispPaid)}</TableCell>
                  <TableCell colSpan={6} className="text-muted-foreground">Saldo a receber: {formatCurrency(dispSaldo)}</TableCell>
                </TableRow>
              )}
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
            <div className="relative"><Label>Cliente</Label><Input autoComplete="off" placeholder="Busque no cadastro…" value={form.customerName || ''} onChange={e => { const v = e.target.value; setForm({ ...form, customerName: v }); buscarClientes(v); }} onBlur={() => setTimeout(() => setCustSug([]), 150)} />{custSug.length > 0 && (<div className="absolute z-50 left-0 right-0 mt-1 bg-white border rounded shadow max-h-44 overflow-auto">{custSug.map((c: any) => (<button type="button" key={c.id} onMouseDown={(e) => e.preventDefault()} onClick={() => pickCliente(c)} className="block w-full text-left px-3 py-1.5 text-sm hover:bg-green-50">{c.name || c.company_name}{(c.cnpj || c.cpf) ? <span className="text-gray-400 text-xs"> · {c.cnpj || c.cpf}</span> : null}</button>))}</div>)}</div>
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
            <div>
              <Label>Categoria (DRE) *</Label>
              <Select value={form.chartAccountId || 'none'} onValueChange={v => setForm({ ...form, chartAccountId: v === 'none' ? '' : v })}>
                <SelectTrigger data-testid="select-dre-categoria"><SelectValue placeholder="Selecione a categoria do plano de contas" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value="none">Selecione…</SelectItem>
                  {dreAccounts.map((a: any) => <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {!form.chartAccountId && <div className="text-xs text-red-600 mt-1">Obrigatório — nenhuma conta é criada sem categoria DRE.</div>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancelar</Button>
            <Button onClick={() => createMutation.mutate(form)} disabled={createMutation.isPending || !form.chartAccountId}>
              {createMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Criar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

            <Dialog open={showPhotos} onOpenChange={setShowPhotos}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Camera className="h-5 w-5 text-emerald-600" /> Comprovante de entrega</DialogTitle>
          </DialogHeader>
          <div className="space-y-1 text-sm text-muted-foreground">
            <div><span className="font-medium text-foreground">{photosItem?.customerName || '-'}</span></div>
            <div>{photosItem?.titleNumber ? `NF/Título ${photosItem.titleNumber}` : ''}{photosItem?.amount ? ` · ${formatCurrency(photosItem.amount)}` : ''}</div>
          </div>
          {photosItem?.deliveryPhotos?.length ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
              {photosItem.deliveryPhotos.map((url: string, i: number) => (
                <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="block border rounded-md overflow-hidden hover:opacity-90" title="Abrir em tamanho real">
                  <img src={url} alt={`Comprovante de entrega ${i + 1}`} className="w-full h-56 object-cover bg-muted" loading="lazy" />
                </a>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-6 text-center">Nenhuma foto de entrega encontrada para este título.</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPhotos(false)}>Fechar</Button>
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
            <div className="relative"><Label>Cliente</Label><Input autoComplete="off" placeholder="Busque no cadastro…" value={form.customerName || ''} onChange={e => { const v = e.target.value; setForm({ ...form, customerName: v }); buscarClientes(v); }} onBlur={() => setTimeout(() => setCustSug([]), 150)} />{custSug.length > 0 && (<div className="absolute z-50 left-0 right-0 mt-1 bg-white border rounded shadow max-h-44 overflow-auto">{custSug.map((c: any) => (<button type="button" key={c.id} onMouseDown={(e) => e.preventDefault()} onClick={() => pickCliente(c)} className="block w-full text-left px-3 py-1.5 text-sm hover:bg-green-50">{c.name || c.company_name}{(c.cnpj || c.cpf) ? <span className="text-gray-400 text-xs"> · {c.cnpj || c.cpf}</span> : null}</button>))}</div>)}</div>
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
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Detalhes - Conta a Receber</DialogTitle>
            <DialogDescription>Informações completas da conta</DialogDescription>
          </DialogHeader>
          {selectedItem && (
            <div className="space-y-4">
              {/* Resumo da cobrança */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div><Label className="text-xs text-muted-foreground">Título</Label><p className="font-medium">{selectedItem.titleNumber || history?.receivable?.titleNumber || selectedItem.title || '-'}</p></div>
                <div><Label className="text-xs text-muted-foreground">Cliente</Label><p>{selectedItem.customerName || '-'}</p></div>
                <div><Label className="text-xs text-muted-foreground">CNPJ/CPF</Label><p>{history?.receivable?.customerDocument || selectedItem.customerDocument || '-'}</p></div>
                <div><Label className="text-xs text-muted-foreground">Valor</Label><p className="font-bold text-green-700">{formatCurrency(selectedItem.amount)}</p></div>
                <div><Label className="text-xs text-muted-foreground">Valor Pago</Label><p>{formatCurrency(selectedItem.amountPaid)}</p></div>
                <div><Label className="text-xs text-muted-foreground">Status</Label><div>{getReceivableStatusBadge(selectedItem.status, selectedItem.dueDate)}</div></div>
                <div><Label className="text-xs text-muted-foreground">Emissão</Label><p>{formatDate(history?.receivable?.issueDate || selectedItem.issueDate)}</p></div>
                <div><Label className="text-xs text-muted-foreground">Vencimento</Label><p>{formatDate(selectedItem.dueDate)}</p></div>
                <div><Label className="text-xs text-muted-foreground">Forma Pgto</Label><p>{selectedItem.paymentMethod || '-'}</p></div>
                <div><Label className="text-xs text-muted-foreground">Instância</Label><p>{instanceNames[selectedItem.omieInstanceId] || instanceNames[history?.receivable?.omieInstanceId] || selectedItem.omieInstanceId || history?.receivable?.omieInstanceId || '-'}</p></div>
                <div><Label className="text-xs text-muted-foreground">Criada por</Label><p className="text-sm">{history?.receivable?.createdBy || '-'}<span className="text-xs text-muted-foreground">{history?.receivable?.createdAt ? ' · ' + formatDateTime(history.receivable.createdAt) : ''}</span></p></div>
                {history?.receivable?.updatedBy && <div><Label className="text-xs text-muted-foreground">Última edição</Label><p className="text-sm">{history.receivable.updatedBy}<span className="text-xs text-muted-foreground">{history?.receivable?.updatedAt ? ' · ' + formatDateTime(history.receivable.updatedAt) : ''}</span></p></div>}
              </div>
              {selectedItem.description && <div><Label className="text-xs text-muted-foreground">Descrição</Label><p className="text-sm bg-muted p-2 rounded">{selectedItem.description}</p></div>}

              {historyLoading && <p className="text-sm text-muted-foreground">Carregando histórico…</p>}

              {/* Documento fiscal (NF-e) */}
              {history?.fiscalInvoice && (
                <div className="border rounded p-2">
                  <p className="text-xs font-semibold text-muted-foreground mb-1">Documento fiscal (NF-e)</p>
                  <p className="text-sm">NF-e nº <b>{history.fiscalInvoice.invoiceNumber || '-'}</b> · {history.fiscalInvoice.status}{history.fiscalInvoice.emissionDate ? ' · ' + formatDate(history.fiscalInvoice.emissionDate) : ''}</p>
                  {history.fiscalInvoice.accessKey && <p className="text-[11px] text-muted-foreground break-all">Chave: {history.fiscalInvoice.accessKey}</p>}
                </div>
              )}

              {/* Documento de cobrança: boletos + PIX */}
              {(((history?.boletos?.length || 0) + (history?.pix?.length || 0)) > 0) && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1">Documento de cobrança</p>
                  <div className="space-y-2">
                    {(history?.boletos || []).map((b: any) => (
                      <div key={b.id} className="border rounded p-2 text-sm">
                        <div className="flex justify-between gap-2"><span>Boleto · Nosso nº {b.nossoNumero || '-'}</span><Badge variant="outline">{b.status}</Badge></div>
                        <p className="text-xs text-muted-foreground">Emitido {formatDateTime(b.createdAt)} · Venc. {formatDate(b.dueDate)} · {formatCurrency(b.amount)}</p>
                        {b.linhaDigitavel && <p className="text-[11px] break-all">Linha digitável: {b.linhaDigitavel}</p>}
                        {b.canceledAt && <p className="text-[11px] text-red-600">Cancelado {formatDateTime(b.canceledAt)}{b.canceledBy ? ' · ' + b.canceledBy : ''}</p>}
                      </div>
                    ))}
                    {(history?.pix || []).map((p: any) => (
                      <div key={p.id} className="border rounded p-2 text-sm">
                        <div className="flex justify-between gap-2"><span>PIX · {String(p.txid || '').slice(0, 16)}…</span><Badge variant="outline">{p.status}</Badge></div>
                        <p className="text-xs text-muted-foreground">Criado {formatDateTime(p.createdAt)}{p.createdBy ? ' por ' + p.createdBy : ''} · {formatCurrency(p.amount)}{p.paidAt ? ' · pago ' + formatDateTime(p.paidAt) : ''}</p>
                        {p.endToEndId && <p className="text-[11px] text-muted-foreground break-all">E2E: {p.endToEndId}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Recebimentos / baixas */}
              {((history?.payments?.length || 0) > 0) && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1">Recebimentos / baixas</p>
                  <div className="space-y-1">
                    {(history?.payments || []).map((p: any) => (
                      <div key={p.id} className="border rounded p-2 text-sm flex justify-between gap-2">
                        <div><b className="text-green-700">{formatCurrency(p.amount)}</b> · {p.paymentMethod || '-'}{p.notes ? <span className="text-muted-foreground"> · {p.notes}</span> : null}</div>
                        <div className="text-xs text-muted-foreground text-right whitespace-nowrap">{formatDateTime(p.paidAt)}<br />{p.createdBy || '-'}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Conciliações bancárias */}
              {((history?.reconciliations?.length || 0) > 0) && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1">Conciliações bancárias</p>
                  <div className="space-y-1">
                    {(history?.reconciliations || []).map((r: any) => (
                      <div key={r.id} className="border rounded p-2 text-sm">
                        <div className="flex justify-between gap-2"><span>{r.itemDescription || r.originName || 'Extrato'}{r.itemAmount ? ' · ' + formatCurrency(r.itemAmount) : ''}</span><span className="text-xs text-muted-foreground whitespace-nowrap">{r.matchedAt ? formatDateTime(r.matchedAt) : ''}</span></div>
                        <p className="text-xs text-muted-foreground">Conciliado por {r.matchedBy || r.createdBy || '-'}{r.account ? ' · ' + r.account : ''}{r.statement ? ' · ' + r.statement : ''}{(r.interest && Number(r.interest) > 0) ? ' · juros ' + formatCurrency(r.interest) : ''}{(r.discount && Number(r.discount) > 0) ? ' · desc. ' + formatCurrency(r.discount) : ''}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Linha do tempo consolidada */}
              {((history?.timeline?.length || 0) > 0) && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1">Linha do tempo</p>
                  <div className="space-y-1 border-l-2 border-muted pl-3">
                    {(history?.timeline || []).map((t: any, i: number) => (
                      <div key={i} className="flex flex-wrap gap-x-2 text-sm items-baseline">
                        <span className="text-xs text-muted-foreground whitespace-nowrap w-[120px]">{formatDateTime(t.date)}</span>
                        <span className="font-medium">{t.label}</span>
                        <span className="text-muted-foreground text-xs">{t.detail || ''}{t.user ? ' — ' + t.user : ''}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
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
  const [statusMulti, setStatusMulti] = useState<string[]>([]);
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
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const [supSug, setSupSug] = useState<any[]>([]);
  const supTimer = useRef<any>(null);
  const [danfeFile, setDanfeFile] = useState<File | null>(null);
  const [boletoFiles, setBoletoFiles] = useState<File[]>([]);
  const [attBusy, setAttBusy] = useState(false);
  const [dupInfo, setDupInfo] = useState<any>(null);
  const { data: payableAttachments = [], refetch: refetchAttachments } = useQuery<any[]>({
    queryKey: ['/api/financial/payables', selectedItem?.id, 'attachments'],
    queryFn: async () => { if (!selectedItem?.id) return []; const r = await fetch(`/api/financial/payables/${selectedItem.id}/attachments`, { credentials: 'include' }); return r.ok ? r.json() : []; },
    enabled: !!(showDetail && selectedItem?.id),
  });
  const fileToBase64 = (file: File) => new Promise<string>((resolve, reject) => { const rd = new FileReader(); rd.onload = () => resolve(String(rd.result).split(',')[1] || ''); rd.onerror = reject; rd.readAsDataURL(file); });
  const uploadPayableAttachments = async (payableId: string) => {
    const jobs: { kind: string; file: File }[] = [];
    if (danfeFile) jobs.push({ kind: 'danfe', file: danfeFile });
    boletoFiles.forEach((f) => jobs.push({ kind: 'boleto', file: f }));
    for (const j of jobs) {
      const b64 = await fileToBase64(j.file);
      await fetch(`/api/financial/payables/${payableId}/attachments`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: j.kind, fileName: j.file.name, mimeType: j.file.type || 'application/octet-stream', base64: b64 }) });
    }
  };
  const submitCreatePayable = async (force = false) => {
    if (!form.chartAccountId) return;
    setAttBusy(true);
    try {
      const rec = (form.recurFreq && form.recurFreq !== 'none') ? { freq: form.recurFreq, interval: form.recurInterval || 1, endType: form.recurEndType || 'count', count: form.recurCount || 12, until: form.recurUntil || '' } : undefined;
      const res: any = await apiRequest('POST', '/api/financial/payables', { ...form, source: 'manual', recurrence: rec, allowDuplicate: force });
      const payableId = res?.id || (Array.isArray(res?.items) && res.items[0]?.id) || null;
      if (payableId && (danfeFile || boletoFiles.length)) {
        try { await uploadPayableAttachments(payableId); } catch (e: any) { toast({ title: 'Conta criada, mas falha ao anexar arquivos', description: e?.message, variant: 'destructive' }); }
      }
      // BAIXA IMEDIATA (Instancia CAIXINHA = dinheiro a vista): apos criar, ja registra o pagamento
      // reutilizando o MESMO mecanismo de baixa do "Registrar Pagamento" (POST .../payments).
      // Nao se aplica a recorrencia (vencimentos futuros nao devem ser baixados hoje).
      let baixado = false;
      if (form.instanceId === 'CAIXINHA' && !rec && payableId) {
        const baixaValRaw = (form.cxAmount !== undefined && form.cxAmount !== '') ? form.cxAmount : form.amount;
        const baixaVal = Number(String(baixaValRaw ?? '').replace(',', '.'));
        if (baixaVal > 0) {
          try {
            await apiRequest('POST', `/api/financial/payables/${payableId}/payments`, {
              amount: String(baixaValRaw),
              paymentMethod: 'dinheiro',
              financialAccountId: caixinhaAccount?.id || null,
              paymentDate: form.cxPaymentDate || new Date().toISOString().split('T')[0],
              reference: 'Baixa Caixinha (à vista)',
              notes: 'Baixa imediata à vista lançada junto com a conta (Instância CAIXINHA)',
            });
            baixado = true;
          } catch (e: any) {
            toast({ title: 'Conta criada, mas falha ao dar baixa (Caixinha)', description: e?.message || String(e), variant: 'destructive' });
          }
        }
      }
      queryClient.invalidateQueries({ queryKey: ['/api/financial/payables'] });
      setShowCreate(false); setDanfeFile(null); setBoletoFiles([]); setDupInfo(null);
      toast({ title: res?.recurring ? `${res.count} contas a pagar criadas` : (baixado ? 'Conta a pagar criada e BAIXADA (Caixinha)' : 'Conta a pagar criada com sucesso') });
    } catch (e: any) {
      if (e?.status === 409 && e?.duplicate) { setDupInfo({ existing: e?.existing || null }); }
      else { toast({ title: 'Erro', description: e?.message || String(e), variant: 'destructive' }); }
    }
    finally { setAttBusy(false); }
  };
  const buscarFornecedores = (v: string) => {
    if (supTimer.current) clearTimeout(supTimer.current);
    const q = (v || '').trim();
    if (q.length < 2) { setSupSug([]); return; }
    supTimer.current = setTimeout(async () => {
      try {
        const r = await fetch('/api/reconciliation/suppliers/search?q=' + encodeURIComponent(q), { credentials: 'include' });
        const j = await r.json();
        setSupSug(Array.isArray(j.suppliers) ? j.suppliers : []);
      } catch { setSupSug([]); }
    }, 250);
  };
  const pickFornecedor = (s: any) => {
    setForm((f: any) => ({ ...f, supplierName: s.name || '', supplierDocument: s.cnpj || s.cpf || f.supplierDocument || '', chartAccountId: s.default_chart_account_id || f.chartAccountId || '' }));
    setSupSug([]);
  };

  const buildUrl = () => {
    const p = new URLSearchParams();
    if (instanceId) p.set('instanceId', instanceId);
    if (sourceFilter) p.set('source', sourceFilter);
    if (startDate) p.set('startDate', startDate);
    if (endDate) p.set('endDate', endDate);
    if (dueDateStart) p.set('dueDateStart', dueDateStart);
    if (dueDateEnd) p.set('dueDateEnd', dueDateEnd);
    const qs = p.toString();
    return `/api/financial/payables${qs ? `?${qs}` : ''}`;
  };

  const instanceNames = useInstanceNames();
  const { data: payables = [], isLoading } = useQuery<any[]>({
    queryKey: ['/api/financial/payables', instanceId, sourceFilter, startDate, endDate, dueDateStart, dueDateEnd],
    queryFn: () => fetch(buildUrl(), { credentials: 'include' }).then(r => r.json()),
  });

  const { data: accounts = [] } = useQuery<any[]>({
    queryKey: ['/api/financial/accounts'],
  });
  // Conta financeira "CAIXINHA" (dinheiro a vista) — usada na baixa imediata do lancamento manual.
  const caixinhaAccount = (accounts as any[]).find((a: any) => String(a.name || '').trim().toUpperCase() === 'CAIXINHA');

  const [sortAZ, setSortAZ] = useState(false);
  const [valueMin, setValueMin] = useState('');
  const [valueMax, setValueMax] = useState('');
  const filtered = payables.filter((p: any) => {
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      if (!(p.supplierName || '').toLowerCase().includes(q) && !(p.supplierDocument || '').includes(q)) return false;
    }
    if (statusMulti.length > 0) {
      const eff = (p.status === 'a_vencer' && p.dueDate && new Date(p.dueDate) < new Date()) ? 'vencida' : p.status;
      const label = eff === 'a_vencer' ? 'A Vencer' : eff === 'paga' ? 'Paga' : eff === 'vencida' ? 'Atrasada' : eff === 'cancelada' ? 'Cancelada' : String(eff);
      if (!statusMulti.includes(label)) return false;
    }
    if (valueMin !== '' && Number(p.amount || 0) < parseFloat(String(valueMin).replace(',', '.'))) return false;
    if (valueMax !== '' && Number(p.amount || 0) > parseFloat(String(valueMax).replace(',', '.'))) return false;
    return true;
  });
  if (sortAZ) filtered.sort((a: any, b: any) => String(a.supplierName || '').localeCompare(String(b.supplierName || '')));

  // FASE 3.4e - categorias analiticas do DRE p/ o campo obrigatorio do formulario
  const { data: dreAccounts = [] } = useQuery<any[]>({
    queryKey: ['/api/financial/chart-of-accounts', 'dre-pay'],
    queryFn: async () => { const r = await fetch('/api/financial/chart-of-accounts', { credentials: 'include' }); if (!r.ok) return []; const d = await r.json(); return (Array.isArray(d) ? d : []).filter((a: any) => String(a.code).includes('.') && a.isActive !== false).sort((a: any, b: any) => String(a.code).localeCompare(String(b.code))); },
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest('POST', '/api/financial/payables', data),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/financial/payables'] });
      setShowCreate(false);
      toast({ title: res?.recurring ? `${res.count} contas a pagar criadas` : 'Conta a pagar criada com sucesso' });
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

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) { await apiRequest('DELETE', `/api/financial/payables/${id}`); }
      return ids.length;
    },
    onSuccess: (n: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/financial/payables'] });
      setShowBulkDelete(false);
      setSelectedIds([]);
      toast({ title: `${n} conta(s) excluída(s)` });
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
      <ReconcileButton table="payables" />
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
          <Label className="text-xs">Valor (R$)</Label>
          <div className="flex gap-1 items-center">
            <Input type="number" step="0.01" placeholder="mín." value={valueMin} onChange={e => setValueMin(e.target.value)} className="w-[90px]" data-testid="filter-valuemin-payables" />
            <span className="text-xs text-muted-foreground">até</span>
            <Input type="number" step="0.01" placeholder="máx." value={valueMax} onChange={e => setValueMax(e.target.value)} className="w-[90px]" data-testid="filter-valuemax-payables" />
          </div>
        </div>
          <div className="flex gap-2 items-end">
            <Button type="button" variant="outline" size="sm" onClick={() => setSortAZ(!sortAZ)} data-testid="sort-az-payables">{sortAZ ? "Fornecedor A-Z: ligado" : "Ordenar A-Z"}</Button>
            <ExportExcelButton testId="export-payables" onClick={() => exportToExcel(filtered.map((p: any) => ({ Titulo: p.titleNumber, Fornecedor: p.supplierName, Documento: p.supplierDocument, Descricao: p.description, Valor: Number(p.amount || 0), ValorPago: Number(p.amountPaid || 0), Status: p.status, Vencimento: p.dueDate ? new Date(p.dueDate).toLocaleDateString("pt-BR") : "" })), "contas-a-pagar")} />
          </div>
        <div>
          <Label className="text-xs block mb-1">Status</Label>
          <MultiSelect label="Status" options={['A Vencer', 'Paga', 'Atrasada', 'Cancelada']} selected={statusMulti} onChange={setStatusMulti} testId="filter-status-payables" />
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
        <Button onClick={() => { setForm({ title: '', supplierName: '', supplierDocument: '', description: '', amount: '', dueDate: '', paymentMethod: '', instanceId: '', chartAccountId: '', cxPaymentDate: '', cxAmount: '', source: 'manual', recurFreq: 'none', recurInterval: 1, recurEndType: 'count', recurCount: 12, recurUntil: '' }); setSupSug([]); setShowCreate(true); }} className="ml-auto">
          <Plus className="w-4 h-4 mr-2" />Nova Conta a Pagar
        </Button>
        {selectedIds.length > 0 && (
          <Button variant="destructive" onClick={() => setShowBulkDelete(true)} data-testid="btn-bulk-delete-payables">
            <Trash2 className="w-4 h-4 mr-2" />Excluir selecionados ({selectedIds.length})
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-8 w-8 animate-spin" /></div>
      ) : (
        <div className="border rounded-lg overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"><input type="checkbox" className="h-4 w-4 cursor-pointer" aria-label="Selecionar todos" checked={filtered.length > 0 && filtered.slice(0, 300).every((p: any) => selectedIds.includes(p.id))} onChange={e => { const vis = filtered.slice(0, 300).map((p: any) => p.id); setSelectedIds(e.target.checked ? Array.from(new Set([...selectedIds, ...vis])) : selectedIds.filter(id => !vis.includes(id))); }} /></TableHead>
                <TableHead>Título</TableHead>
                <TableHead>Fornecedor</TableHead>
                <TableHead>CNPJ/CPF</TableHead>
                <TableHead>Descrição</TableHead>
                <TableHead className="text-right">Valor</TableHead>
                <TableHead className="text-right">Valor Pago</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Lançamento</TableHead>
                <TableHead>Vencimento</TableHead>
                <TableHead>Origem</TableHead>
                <TableHead>Instância</TableHead>
                <TableHead>Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={13} className="text-center py-8 text-muted-foreground">Nenhuma conta a pagar encontrada</TableCell></TableRow>
              ) : filtered.slice(0, 300).map((p: any) => (
                <TableRow key={p.id}>
                  <TableCell className="w-8"><input type="checkbox" className="h-4 w-4 cursor-pointer" aria-label="Selecionar" checked={selectedIds.includes(p.id)} onChange={e => setSelectedIds(e.target.checked ? [...selectedIds, p.id] : selectedIds.filter(id => id !== p.id))} /></TableCell>
                  <TableCell className="font-medium">{p.titleNumber || '-'}</TableCell>
                  <TableCell>{p.supplierName || '-'}</TableCell>
                  <TableCell className="text-xs">{p.supplierDocument || '-'}</TableCell>
                  <TableCell className="max-w-[180px] truncate">{p.description || '-'}</TableCell>
                  <TableCell className="text-right font-medium">{formatCurrency(p.amount)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(p.amountPaid)}</TableCell>
                  <TableCell>{getPayableStatusBadge(p.status, p.dueDate)}</TableCell>
                  <TableCell><LancamentoBadges item={p} /></TableCell>
                  <TableCell>{formatDate(p.dueDate)}</TableCell>
                  <TableCell><Badge variant="outline">{sourceLabels[p.source] || p.source || '-'}</Badge></TableCell>
                  <TableCell><Badge variant="outline">{instanceNames[p.omieInstanceId] || p.omieInstanceId || '-'}</Badge></TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" onClick={() => { setSelectedItem(p); setShowDetail(true); }}><Eye className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" onClick={() => { setSelectedItem(p); setPaymentForm({ amount: '', paymentMethod: '', financialAccountId: '', paymentDate: new Date().toISOString().split('T')[0], reference: '', notes: '' }); setShowPayment(true); }}><Banknote className="h-4 w-4 text-green-600" /></Button>
                      <Button variant="ghost" size="icon" onClick={() => { setSelectedItem(p); setForm({ ...p }); setSupSug([]); setShowEdit(true); }}><Edit className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" onClick={() => { if (confirm('Remover esta conta a pagar?')) deleteMutation.mutate(p.id); }}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length > 300 && (<TableRow><TableCell colSpan={13} className="text-center py-3 text-amber-700 bg-amber-50">Mostrando as primeiras 300 de {filtered.length} contas — refine por status, período, fornecedor ou busca. O total abaixo considera todas as {filtered.length} contas.</TableCell></TableRow>)}
                  {filtered.length > 0 && (
                <TableRow className="bg-muted/50 font-semibold border-t-2">
                  <TableCell colSpan={5}>Total ({filtered.length} {filtered.length === 1 ? 'conta' : 'contas'})</TableCell>
                  <TableCell className="text-right">{formatCurrency(filtered.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0))}</TableCell>
                  <TableCell className="text-right">{formatCurrency(filtered.reduce((s: number, p: any) => s + (Number(p.amountPaid) || 0), 0))}</TableCell>
                  <TableCell colSpan={6} className="text-muted-foreground">Saldo a pagar: {formatCurrency(filtered.reduce((s: number, p: any) => s + ((Number(p.amount) || 0) - (Number(p.amountPaid) || 0)), 0))}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={showBulkDelete} onOpenChange={setShowBulkDelete}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Excluir contas selecionadas</DialogTitle>
            <DialogDescription>
              Você está prestes a excluir <strong>{selectedIds.length}</strong> conta(s) a pagar. Esta ação NÃO poderá ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBulkDelete(false)}>Cancelar</Button>
            <Button variant="destructive" onClick={() => bulkDeleteMutation.mutate(selectedIds)} disabled={bulkDeleteMutation.isPending} data-testid="btn-confirm-bulk-delete">
              {bulkDeleteMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Excluir selecionados
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Nova Conta a Pagar</DialogTitle>
            <DialogDescription>Preencha os dados da nova conta a pagar</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label>Título</Label><Input value={form.title || ''} onChange={e => setForm({ ...form, title: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="relative"><Label>Fornecedor</Label><Input autoComplete="off" placeholder="Busque no cadastro…" value={form.supplierName || ''} onChange={e => { const v = e.target.value; setForm({ ...form, supplierName: v }); buscarFornecedores(v); }} onBlur={() => setTimeout(() => setSupSug([]), 150)} />{supSug.length > 0 && (<div className="absolute z-50 left-0 right-0 mt-1 bg-white border rounded shadow max-h-44 overflow-auto">{supSug.map((s: any) => (<button type="button" key={s.id} onMouseDown={(e) => e.preventDefault()} onClick={() => pickFornecedor(s)} className="block w-full text-left px-3 py-1.5 text-sm hover:bg-green-50">{s.name}{(s.cnpj || s.cpf) ? <span className="text-gray-400 text-xs"> · {s.cnpj || s.cpf}</span> : null}</button>))}</div>)}</div>
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
                <Select value={form.instanceId || 'none'} onValueChange={v => {
                  const inst = v === 'none' ? '' : v;
                  if (inst === 'CAIXINHA') {
                    setForm({ ...form, instanceId: inst, paymentMethod: form.paymentMethod || 'dinheiro', cxPaymentDate: form.cxPaymentDate || new Date().toISOString().split('T')[0], cxAmount: (form.cxAmount === undefined || form.cxAmount === '') ? (form.amount || '') : form.cxAmount });
                  } else {
                    setForm({ ...form, instanceId: inst });
                  }
                }}>
                  <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Selecione</SelectItem>
                    <SelectItem value="BSB">BSB</SelectItem>
                    <SelectItem value="GYN">GYN</SelectItem>
                    <SelectItem value="IND">IND</SelectItem>
                    <SelectItem value="SERV">SERV</SelectItem>
                    <SelectItem value="CAIXINHA">CAIXINHA</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {form.instanceId === 'CAIXINHA' && (
              <div className="rounded-md border border-green-300 bg-green-50 p-3 space-y-2" data-testid="caixinha-baixa-box">
                <div className="flex items-center gap-2 text-sm font-semibold text-green-800"><Banknote className="w-4 h-4" />Baixa imediata — Caixinha (dinheiro à vista)</div>
                <p className="text-xs text-green-700">Ao clicar em Criar, a conta será lançada e já dada como <strong>PAGA</strong> em dinheiro pela conta <strong>CAIXINHA</strong>, na data e no valor abaixo.</p>
                <div className="grid grid-cols-2 gap-3">
                  <div><Label>Data do Pagamento</Label><Input type="date" value={form.cxPaymentDate || ''} onChange={e => setForm({ ...form, cxPaymentDate: e.target.value })} data-testid="input-caixinha-date" /></div>
                  <div><Label>Valor Pago</Label><Input type="number" step="0.01" value={form.cxAmount ?? ''} onChange={e => setForm({ ...form, cxAmount: e.target.value })} placeholder={form.amount || '0.00'} data-testid="input-caixinha-amount" /></div>
                </div>
                {!caixinhaAccount && <div className="text-xs text-amber-700">⚠ Conta financeira "CAIXINHA" não encontrada no cadastro — a baixa será registrada sem conta vinculada.</div>}
              </div>
            )}
            <div>
              <Label>Categoria (DRE) *</Label>
              <Select value={form.chartAccountId || 'none'} onValueChange={v => setForm({ ...form, chartAccountId: v === 'none' ? '' : v })}>
                <SelectTrigger data-testid="select-dre-categoria"><SelectValue placeholder="Selecione a categoria do plano de contas" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value="none">Selecione…</SelectItem>
                  {dreAccounts.map((a: any) => <SelectItem key={a.id} value={a.id}>{a.code} {a.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {!form.chartAccountId && <div className="text-xs text-red-600 mt-1">Obrigatório — nenhuma conta é criada sem categoria DRE.</div>}
            </div>
            <div className="rounded-md border p-3 space-y-3 bg-muted/30">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Repetição</Label>
                  <Select value={form.recurFreq || 'none'} onValueChange={v => setForm({ ...form, recurFreq: v })}>
                    <SelectTrigger data-testid="select-recur-freq"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Não se repete</SelectItem>
                      <SelectItem value="daily">Diariamente</SelectItem>
                      <SelectItem value="weekly">Semanalmente</SelectItem>
                      <SelectItem value="monthly">Mensalmente</SelectItem>
                      <SelectItem value="yearly">Anualmente</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {form.recurFreq && form.recurFreq !== 'none' && (
                  <div>
                    <Label>Repetir a cada</Label>
                    <div className="flex items-center gap-2">
                      <Input type="number" min="1" className="w-20" value={form.recurInterval ?? 1} onChange={e => setForm({ ...form, recurInterval: e.target.value })} />
                      <span className="text-sm text-muted-foreground">{form.recurFreq === 'daily' ? 'dia(s)' : form.recurFreq === 'weekly' ? 'semana(s)' : form.recurFreq === 'monthly' ? 'mês(es)' : 'ano(s)'}</span>
                    </div>
                  </div>
                )}
              </div>
              {form.recurFreq && form.recurFreq !== 'none' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Termina</Label>
                    <Select value={form.recurEndType || 'count'} onValueChange={v => setForm({ ...form, recurEndType: v })}>
                      <SelectTrigger data-testid="select-recur-end"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="count">Após N ocorrências</SelectItem>
                        <SelectItem value="date">Em uma data</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    {(form.recurEndType || 'count') === 'date' ? (
                      <><Label>Data final</Label><Input type="date" value={form.recurUntil || ''} onChange={e => setForm({ ...form, recurUntil: e.target.value })} /></>
                    ) : (
                      <><Label>Ocorrências</Label><Input type="number" min="1" max="120" value={form.recurCount ?? 12} onChange={e => setForm({ ...form, recurCount: e.target.value })} /></>
                    )}
                  </div>
                </div>
              )}
              {form.recurFreq && form.recurFreq !== 'none' && (
                <p className="text-xs text-muted-foreground">Serão criados vários lançamentos a partir do vencimento informado, conforme a regra acima.</p>
              )}
              <div className="border-t pt-3 mt-1">
                <Label className="text-sm font-semibold">Anexos (DANFE e Boletos)</Label>
                <div className="grid grid-cols-1 gap-2 mt-2">
                  <div>
                    <Label className="text-xs text-muted-foreground">DANFE (PDF ou XML)</Label>
                    <Input type="file" accept=".pdf,.xml,application/pdf,text/xml" onChange={(e) => setDanfeFile(e.target.files?.[0] || null)} />
                    {danfeFile && <p className="text-xs text-green-700 mt-1">✓ {danfeFile.name}</p>}
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Boleto(s) (PDF — pode selecionar vários)</Label>
                    <Input type="file" accept=".pdf,application/pdf" multiple onChange={(e) => setBoletoFiles(Array.from(e.target.files || []))} />
                    {boletoFiles.length > 0 && <p className="text-xs text-green-700 mt-1">✓ {boletoFiles.length} boleto(s): {boletoFiles.map((f) => f.name).join(', ')}</p>}
                  </div>
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowCreate(false); setDanfeFile(null); setBoletoFiles([]); }}>Cancelar</Button>
            <Button onClick={() => submitCreatePayable()} disabled={attBusy || createMutation.isPending || !form.chartAccountId}>
              {(attBusy || createMutation.isPending) && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Criar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!dupInfo} onOpenChange={(o) => { if (!o) setDupInfo(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Possível conta duplicada</DialogTitle>
            <DialogDescription>
              Já existe uma conta a pagar deste fornecedor com o mesmo valor e vencimento próximo. Confira antes de lançar de novo para evitar duplicidade.
            </DialogDescription>
          </DialogHeader>
          {dupInfo?.existing && (
            <div className="text-sm rounded border border-amber-300 bg-amber-50 p-3 space-y-1">
              <div><span className="text-gray-500">Valor:</span> R$ {Number(dupInfo.existing.amount || 0).toFixed(2).replace('.', ',')}</div>
              <div><span className="text-gray-500">Vencimento:</span> {dupInfo.existing.dueDate ? new Date(dupInfo.existing.dueDate).toLocaleDateString('pt-BR') : '—'}</div>
              <div><span className="text-gray-500">Situação:</span> {({ paga: 'Paga', a_vencer: 'A vencer', vencida: 'Atrasada', cancelada: 'Cancelada' } as any)[dupInfo.existing.status] || dupInfo.existing.status}</div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDupInfo(null)}>Cancelar</Button>
            <Button variant="destructive" onClick={() => submitCreatePayable(true)} disabled={attBusy}>
              {attBusy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Criar mesmo assim
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
              <div className="relative"><Label>Fornecedor</Label><Input autoComplete="off" placeholder="Busque no cadastro…" value={form.supplierName || ''} onChange={e => { const v = e.target.value; setForm({ ...form, supplierName: v }); buscarFornecedores(v); }} onBlur={() => setTimeout(() => setSupSug([]), 150)} />{supSug.length > 0 && (<div className="absolute z-50 left-0 right-0 mt-1 bg-white border rounded shadow max-h-44 overflow-auto">{supSug.map((s: any) => (<button type="button" key={s.id} onMouseDown={(e) => e.preventDefault()} onClick={() => pickFornecedor(s)} className="block w-full text-left px-3 py-1.5 text-sm hover:bg-green-50">{s.name}{(s.cnpj || s.cpf) ? <span className="text-gray-400 text-xs"> · {s.cnpj || s.cpf}</span> : null}</button>))}</div>)}</div>
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
              <div>
                <Label className="text-xs text-muted-foreground">Anexos (DANFE / Boletos)</Label>
                {(payableAttachments as any[]).length === 0 ? (
                  <p className="text-sm text-muted-foreground mt-1">Nenhum anexo.</p>
                ) : (
                  <div className="space-y-1 mt-1">
                    {(payableAttachments as any[]).map((a: any) => (
                      <div key={a.id} className="flex items-center justify-between border rounded px-2 py-1 text-sm gap-2">
                        <a href={`/api/financial/payable-attachments/${a.id}/download`} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline truncate">
                          {a.kind === 'danfe' ? '📄 DANFE' : a.kind === 'boleto' ? '🧾 Boleto' : '📎 Anexo'} — {a.file_name}
                        </a>
                        <button title="Remover anexo" onClick={async () => { if (!confirm('Remover este anexo?')) return; await fetch(`/api/financial/payable-attachments/${a.id}`, { method: 'DELETE', credentials: 'include' }); refetchAttachments(); }} className="text-red-500 shrink-0">✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
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
const DRE_GROUP_LABELS: Record<string, string> = {
  receita_bruta: 'Receita Bruta de Vendas',
  devolucoes: 'Devoluções/Descontos',
  impostos_vendas: 'Impostos sobre Vendas',
  cpv: 'CPV',
  despesas_comerciais: 'Despesas Comerciais',
  despesas_administrativas: 'Despesas Administrativas',
  despesas_gerais: 'Despesas Gerais',
  outras_receitas_despesas: 'Outras Receitas/Despesas',
  depreciacao: 'Depreciação e Amortização',
  receitas_financeiras: 'Receitas Financeiras',
  despesas_financeiras: 'Despesas Financeiras',
  irpj_csll: 'IRPJ/CSLL',
};

function ChartOfAccountsTab() {
  const [instanceId, setInstanceId] = useState('');
  const [showDialog, setShowDialog] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [form, setForm] = useState<any>({ code: '', name: '', type: 'receita', dreGroup: '', instanceId: '', isActive: true });

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

  const seedMutation = useMutation({
    mutationFn: () => apiRequest('POST', '/api/financial/chart-of-accounts/seed'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/financial/chart-of-accounts'] });
      toast({ title: 'Plano de contas DRE populado com sucesso' });
    },
    onError: (e: any) => toast({ title: 'Erro', description: e.message, variant: 'destructive' }),
  });

  const typeBadges: Record<string, { label: string; className: string }> = {
    receita: { label: 'Receita', className: 'bg-green-100 text-green-800' },
    despesa: { label: 'Despesa', className: 'bg-red-100 text-red-800' },
    ativo: { label: 'Ativo', className: 'bg-blue-100 text-blue-800' },
    passivo: { label: 'Passivo', className: 'bg-purple-100 text-purple-800' },
  };

  const openCreate = () => { setEditItem(null); setForm({ code: '', name: '', type: 'receita', dreGroup: '', omieInstanceId: '', isActive: true, includeInDre: true }); setShowDialog(true); };
  const openEdit = (item: any) => { setEditItem(item); setForm({ ...item }); setShowDialog(true); };

  const isGroupHeader = (code: string) => !code.includes('.');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end">
        <div><Label className="text-xs">Instância</Label><InstanceFilter value={instanceId} onChange={setInstanceId} /></div>
        <div className="ml-auto flex gap-2">
          {accounts.length === 0 && (
            <Button variant="outline" onClick={() => { if (confirm('Deseja popular o plano de contas com a estrutura padrão da DRE?')) seedMutation.mutate(); }} disabled={seedMutation.isPending}>
              {seedMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              <Database className="w-4 h-4 mr-2" />Popular DRE Padrão
            </Button>
          )}
          <Button onClick={openCreate}><Plus className="w-4 h-4 mr-2" />Nova Conta</Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-8 w-8 animate-spin" /></div>
      ) : (
        <div className="border rounded-lg overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[80px]">Código</TableHead>
                <TableHead>Nome</TableHead>
                <TableHead>Grupo DRE</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[80px]">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Nenhuma conta encontrada. Clique em "Popular DRE Padrão" para criar a estrutura.</TableCell></TableRow>
              ) : accounts.map((a: any) => {
                const tb = typeBadges[a.type] || { label: a.type, className: '' };
                const isHeader = isGroupHeader(a.code);
                return (
                  <TableRow key={a.id} className={isHeader ? 'bg-muted/50 font-semibold' : ''}>
                    <TableCell className="font-mono text-xs">{a.code || '-'}</TableCell>
                    <TableCell className={isHeader ? 'font-semibold' : 'pl-8'}>{isHeader ? '' : '(-) '}{a.name}</TableCell>
                    <TableCell>{a.includeInDre === false ? <Badge variant="outline" className="border-amber-400 text-amber-700">Só Fluxo de Caixa</Badge> : <span className="text-xs text-muted-foreground">{DRE_GROUP_LABELS[a.dreGroup] || a.dreGroup || '-'}</span>}</TableCell>
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
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Código</Label><Input value={form.code || ''} onChange={e => setForm({ ...form, code: e.target.value })} placeholder="2.01" /></div>
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
            </div>
            <div><Label>Nome</Label><Input value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
            <div>
              <Label>Grupo DRE</Label>
              <Select value={form.dreGroup || 'none'} onValueChange={v => setForm({ ...form, dreGroup: v === 'none' ? '' : v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nenhum</SelectItem>
                  {Object.entries(DRE_GROUP_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="rounded-md border p-3 bg-muted/30">
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="checkbox" checked={form.includeInDre !== false} onChange={e => setForm({ ...form, includeInDre: e.target.checked })} className="h-4 w-4 mt-0.5" />
                <span>
                  <span className="text-sm font-medium">Considerar na DRE</span>
                  <span className="block text-xs text-muted-foreground">{form.includeInDre === false ? 'Conta só de fluxo de caixa (não entra na DRE). Ex.: Aportes.' : 'Desmarque para que a conta apareça apenas no fluxo de caixa (ex.: Aportes), fora da DRE.'}</span>
                </span>
              </label>
            </div>
            <div>
              <Label>Instância</Label>
              <Select value={form.omieInstanceId || 'none'} onValueChange={v => setForm({ ...form, omieInstanceId: v === 'none' ? '' : v })}>
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
  const [selectedAccount, setSelectedAccount] = useState<any>(null);
  const [activeSubTab, setActiveSubTab] = useState('list');
  const [showPixDialog, setShowPixDialog] = useState(false);
  const [pixForm, setPixForm] = useState<any>({ accountId: '', amount: '', debtorName: '', debtorDocument: '', description: '', chargeType: 'imediata', dueDate: '', expirationSeconds: '3600' });
  const [form, setForm] = useState<any>({
    name: '', type: 'banco', accountSubtype: 'conta_corrente', bankName: '', bankCode: '', agency: '', accountNumber: '', pixKey: '',
    omieInstanceId: '', isActive: true,
    bbClientId: '', bbClientSecret: '', bbDevAppKey: '', bbConvenio: '', bbContrato: '',
    bbPixEnabled: false, bbBoletoEnabled: false,
    bbCarteira: '', bbVariacaoCarteira: '',
    bbJurosPercentual: '', bbMultaPercentual: '',
    bbDiasCompensacao: 'nenhum', bbSenhaBoletos: 'nenhuma',
    bbInstrucaoLinha1: '', bbInstrucaoLinha2: '', bbInstrucaoLinha3: '', bbInstrucaoLinha4: '',
  });

  const { data: accounts = [], isLoading } = useQuery<any[]>({
    queryKey: ['/api/financial/accounts', instanceId],
    queryFn: () => fetch(`/api/financial/accounts${instanceId ? `?instanceId=${instanceId}` : ''}`, { credentials: 'include' }).then(r => r.json()),
  });

  const { data: movements = [] } = useQuery<any[]>({
    queryKey: ['/api/financial/accounts', selectedAccount?.id, 'movements'],
    queryFn: () => fetch(`/api/financial/accounts/${selectedAccount?.id}/movements?limit=100`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!selectedAccount?.id && activeSubTab === 'movements',
  });

  const { data: pixCharges = [] } = useQuery<any[]>({
    queryKey: ['/api/financial/pix-charges', selectedAccount?.id],
    queryFn: () => fetch(`/api/financial/pix-charges?financialAccountId=${selectedAccount?.id}`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!selectedAccount?.id && activeSubTab === 'pix',
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

  const testBBMutation = useMutation({
    mutationFn: (id: string) => apiRequest('POST', `/api/financial/accounts/${id}/test-bb-pix`),
    onSuccess: (data: any) => {
      if (data.success) toast({ title: 'Conexão OK', description: data.message });
      else toast({ title: 'Falha na conexão', description: data.message, variant: 'destructive' });
    },
    onError: (e: any) => toast({ title: 'Erro', description: e.message, variant: 'destructive' }),
  });

  const createPixMutation = useMutation({
    mutationFn: (data: any) => {
      const endpoint = data.chargeType === 'com_vencimento' ? '/api/financial/pix-charges/due-date' : '/api/financial/pix-charges/immediate';
      return apiRequest('POST', endpoint, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/financial/pix-charges'] });
      setShowPixDialog(false);
      toast({ title: 'Cobrança PIX criada com sucesso' });
    },
    onError: (e: any) => toast({ title: 'Erro ao criar cobrança PIX', description: e.message, variant: 'destructive' }),
  });

  const checkPixStatusMutation = useMutation({
    mutationFn: (id: string) => apiRequest('POST', `/api/financial/pix-charges/${id}/check-status`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/financial/pix-charges'] });
      toast({ title: 'Status atualizado' });
    },
    onError: (e: any) => toast({ title: 'Erro', description: e.message, variant: 'destructive' }),
  });

  const typeLabels: Record<string, string> = { caixa: 'Caixa', banco: 'Banco', carteira_digital: 'Carteira Digital' };
  const typeIcons: Record<string, any> = { caixa: Banknote, banco: Landmark, carteira_digital: CreditCard };

  const BANK_LIST = [
    { code: '001', name: 'Banco do Brasil' },
    { code: '033', name: 'Santander' },
    { code: '104', name: 'Caixa Econômica Federal' },
    { code: '237', name: 'Bradesco' },
    { code: '341', name: 'Itaú Unibanco' },
    { code: '260', name: 'Nu Pagamentos (Nubank)' },
    { code: '077', name: 'Banco Inter' },
    { code: '756', name: 'Sicoob' },
    { code: '748', name: 'Sicredi' },
    { code: '422', name: 'Safra' },
    { code: '212', name: 'Banco Original' },
    { code: '336', name: 'C6 Bank' },
    { code: '290', name: 'PagSeguro' },
    { code: '380', name: 'PicPay' },
    { code: '403', name: 'Cora' },
    { code: '197', name: 'Stone Pagamentos' },
    { code: '655', name: 'Neon' },
    { code: '070', name: 'BRB' },
    { code: '085', name: 'AILOS' },
    { code: '136', name: 'Unicred' },
    { code: '318', name: 'BMG' },
    { code: '389', name: 'Mercantil do Brasil' },
    { code: '634', name: 'Triângulo' },
    { code: '741', name: 'BRP' },
    { code: '999', name: 'Outro' },
  ];

  const ACCOUNT_SUBTYPES = [
    { value: 'conta_corrente', label: 'Conta Corrente' },
    { value: 'poupanca', label: 'Poupança' },
    { value: 'conta_pagamento', label: 'Conta Pagamento' },
    { value: 'conta_salario', label: 'Conta Salário' },
  ];

  const openCreate = () => {
    setEditItem(null);
    setForm({
      name: '', type: 'banco', accountSubtype: 'conta_corrente', bankName: '', bankCode: '', agency: '', accountNumber: '', pixKey: '',
      omieInstanceId: '', isActive: true, balance: '0',
      bbClientId: '', bbClientSecret: '', bbDevAppKey: '', bbConvenio: '', bbContrato: '',
      bbPixEnabled: false, bbBoletoEnabled: false,
      bbPixClientId: '', bbPixClientSecret: '',
      bbPagamentosClientId: '', bbPagamentosClientSecret: '',
      bbExtratoClientId: '', bbExtratoClientSecret: '',
      bbCarteira: '', bbVariacaoCarteira: '',
      bbJurosPercentual: '', bbMultaPercentual: '',
      bbDiasCompensacao: 'nenhum', bbSenhaBoletos: 'nenhuma',
      bbInstrucaoLinha1: '', bbInstrucaoLinha2: '', bbInstrucaoLinha3: '', bbInstrucaoLinha4: '',
    });
    setShowDialog(true);
  };

  const handleBankSelect = (code: string) => {
    const bank = BANK_LIST.find(b => b.code === code);
    setForm({ ...form, bankCode: code, bankName: bank ? bank.name : '' });
  };

  const openEdit = (item: any) => {
    setEditItem(item);
    setForm({
      ...item,
      omieInstanceId: item.omieInstanceId || '',
      description: item.description || '',
      balance: item.balance ?? '0',
      accountSubtype: item.accountSubtype || 'conta_corrente',
      bbPixClientId: item.bbPixClientId || '',
      bbPixClientSecret: item.bbPixClientSecret || '',
      bbPagamentosClientId: item.bbPagamentosClientId || '',
      bbPagamentosClientSecret: item.bbPagamentosClientSecret || '',
      bbExtratoClientId: item.bbExtratoClientId || '',
      bbExtratoClientSecret: item.bbExtratoClientSecret || '',
      bbContrato: item.bbContrato || '',
      bbCarteira: item.bbCarteira || '',
      bbVariacaoCarteira: item.bbVariacaoCarteira || '',
      bbJurosPercentual: item.bbJurosPercentual || '',
      bbMultaPercentual: item.bbMultaPercentual || '',
      bbDiasCompensacao: item.bbDiasCompensacao || 'nenhum',
      bbSenhaBoletos: item.bbSenhaBoletos || 'nenhuma',
      bbInstrucaoLinha1: item.bbInstrucaoLinha1 || '',
      bbInstrucaoLinha2: item.bbInstrucaoLinha2 || '',
      bbInstrucaoLinha3: item.bbInstrucaoLinha3 || '',
      bbInstrucaoLinha4: item.bbInstrucaoLinha4 || '',
    });
    setShowDialog(true);
  };

  const handleSave = () => {
    const saveData = { ...form };
    if (saveData.omieInstanceId === '' || saveData.omieInstanceId === 'none') saveData.omieInstanceId = null;
    if (editItem) {
      if (saveData.bbClientSecret === '***') delete saveData.bbClientSecret;
      if (saveData.bbDevAppKey && saveData.bbDevAppKey.endsWith('***')) delete saveData.bbDevAppKey;
      if (saveData.bbPixClientSecret === '***') delete saveData.bbPixClientSecret;
      if (saveData.bbPagamentosClientSecret === '***') delete saveData.bbPagamentosClientSecret;
      if (saveData.bbExtratoClientSecret === '***') delete saveData.bbExtratoClientSecret;
      updateMutation.mutate(saveData);
    } else {
      createMutation.mutate(saveData);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: 'Copiado!' });
  };

  const pixStatusColors: Record<string, string> = {
    'ATIVA': 'bg-blue-100 text-blue-800',
    'CONCLUIDA': 'bg-green-100 text-green-800',
    'EXPIRADA': 'bg-gray-100 text-gray-800',
    'REMOVIDA_PELO_USUARIO_RECEBEDOR': 'bg-orange-100 text-orange-800',
    'REMOVIDA_PELO_PSP': 'bg-red-100 text-red-800',
  };

  const pixStatusLabels: Record<string, string> = {
    'ATIVA': 'Ativa',
    'CONCLUIDA': 'Paga',
    'EXPIRADA': 'Expirada',
    'REMOVIDA_PELO_USUARIO_RECEBEDOR': 'Cancelada',
    'REMOVIDA_PELO_PSP': 'Removida PSP',
  };

  if (selectedAccount) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => { setSelectedAccount(null); setActiveSubTab('list'); }}>Voltar</Button>
          <div>
            <h3 className="text-lg font-bold flex items-center gap-2">
              {(() => { const Icon = typeIcons[selectedAccount.type] || Landmark; return <Icon className="h-5 w-5" />; })()}
              {selectedAccount.name}
            </h3>
            <p className="text-sm text-muted-foreground">
              {selectedAccount.bankName ? `${selectedAccount.bankName} - ` : ''}{selectedAccount.agency ? `Ag: ${selectedAccount.agency} ` : ''}{selectedAccount.accountNumber ? `CC: ${selectedAccount.accountNumber}` : ''}
              {selectedAccount.omieInstanceId ? ` | ${selectedAccount.omieInstanceId}` : ''}
            </p>
          </div>
          <div className="ml-auto text-right">
            <p className="text-xs text-muted-foreground">Saldo</p>
            <p className="text-xl font-bold">{formatCurrency(selectedAccount.balance)}</p>
          </div>
        </div>

        <Tabs value={activeSubTab} onValueChange={setActiveSubTab}>
          <TabsList>
            <TabsTrigger value="movements" className="gap-1"><History className="h-4 w-4" />Movimentações</TabsTrigger>
            <TabsTrigger value="pix" className="gap-1"><QrCode className="h-4 w-4" />Cobranças PIX</TabsTrigger>
            <TabsTrigger value="config" className="gap-1"><Key className="h-4 w-4" />Configuração</TabsTrigger>
          </TabsList>

          <TabsContent value="movements">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Histórico de Movimentações</CardTitle>
                <p className="text-xs text-muted-foreground">Registro imutável de todas as movimentações desta conta</p>
              </CardHeader>
              <CardContent>
                {movements.length === 0 ? (
                  <p className="text-center py-8 text-muted-foreground">Nenhuma movimentação registrada</p>
                ) : (
                  <div className="border rounded-lg overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Data</TableHead>
                          <TableHead>Tipo</TableHead>
                          <TableHead>Descrição</TableHead>
                          <TableHead>Referência</TableHead>
                          <TableHead className="text-right">Valor</TableHead>
                          <TableHead className="text-right">Saldo</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {movements.map((m: any) => (
                          <TableRow key={m.id}>
                            <TableCell className="text-xs whitespace-nowrap">{new Date(m.createdAt).toLocaleString('pt-BR')}</TableCell>
                            <TableCell>
                              {m.type === 'credito'
                                ? <Badge className="bg-green-100 text-green-800 gap-1"><ArrowUpCircle className="h-3 w-3" />Crédito</Badge>
                                : <Badge className="bg-red-100 text-red-800 gap-1"><ArrowDownCircle className="h-3 w-3" />Débito</Badge>}
                            </TableCell>
                            <TableCell className="text-xs max-w-[300px]">{m.description}</TableCell>
                            <TableCell className="text-xs">{m.reference || '-'}</TableCell>
                            <TableCell className={`text-right font-medium ${m.type === 'credito' ? 'text-green-600' : 'text-red-600'}`}>
                              {m.type === 'credito' ? '+' : '-'}{formatCurrency(m.amount)}
                            </TableCell>
                            <TableCell className="text-right font-medium">{formatCurrency(m.balanceAfter)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="pix">
            <Card>
              <CardHeader className="pb-3 flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-base">Cobranças PIX</CardTitle>
                  <p className="text-xs text-muted-foreground">QR Codes dinâmicos gerados via Banco do Brasil</p>
                </div>
                <Button size="sm" onClick={() => {
                  setPixForm({ accountId: selectedAccount.id, amount: '', debtorName: '', debtorDocument: '', description: '', chargeType: 'imediata', dueDate: '', expirationSeconds: '3600' });
                  setShowPixDialog(true);
                }} disabled={!selectedAccount.bbPixEnabled}>
                  <QrCode className="h-4 w-4 mr-2" />Nova Cobrança PIX
                </Button>
              </CardHeader>
              <CardContent>
                {!selectedAccount.bbPixEnabled && (
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4 flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5" />
                    <div>
                      <p className="font-medium text-yellow-800">PIX BB não configurado</p>
                      <p className="text-sm text-yellow-700">Configure as credenciais do Banco do Brasil na aba Configuração para habilitar cobranças PIX.</p>
                    </div>
                  </div>
                )}
                {pixCharges.length === 0 ? (
                  <p className="text-center py-8 text-muted-foreground">Nenhuma cobrança PIX encontrada</p>
                ) : (
                  <div className="space-y-3">
                    {pixCharges.map((ch: any) => (
                      <div key={ch.id} className="border rounded-lg p-4">
                        <div className="flex items-start justify-between">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <Badge className={pixStatusColors[ch.status] || 'bg-gray-100'}>{pixStatusLabels[ch.status] || ch.status}</Badge>
                              <span className="text-xs text-muted-foreground">{ch.chargeType === 'com_vencimento' ? 'Com vencimento' : 'Imediata'}</span>
                            </div>
                            <p className="font-bold text-lg">{formatCurrency(ch.amount)}</p>
                            {ch.debtorName && <p className="text-sm">{ch.debtorName} {ch.debtorDocument ? `(${ch.debtorDocument})` : ''}</p>}
                            {ch.description && <p className="text-xs text-muted-foreground">{ch.description}</p>}
                            <p className="text-xs text-muted-foreground">Criado: {new Date(ch.createdAt).toLocaleString('pt-BR')}</p>
                            {ch.paidAt && <p className="text-xs text-green-600 font-medium">Pago em: {new Date(ch.paidAt).toLocaleString('pt-BR')} | e2e: {ch.endToEndId}</p>}
                          </div>
                          <div className="flex flex-col items-end gap-2">
                            {ch.qrCodeBase64 && ch.status === 'ATIVA' && (
                              <img src={ch.qrCodeBase64} alt="QR Code PIX" className="w-32 h-32 border rounded" />
                            )}
                            <div className="flex gap-1">
                              {ch.pixCopiaECola && ch.status === 'ATIVA' && (
                                <Button variant="outline" size="sm" onClick={() => copyToClipboard(ch.pixCopiaECola)}>
                                  <Copy className="h-3 w-3 mr-1" />Copia e Cola
                                </Button>
                              )}
                              {ch.status === 'ATIVA' && (
                                <Button variant="outline" size="sm" onClick={() => checkPixStatusMutation.mutate(ch.id)} disabled={checkPixStatusMutation.isPending}>
                                  <RefreshCw className="h-3 w-3 mr-1" />Verificar
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="config">
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Landmark className="h-5 w-5 text-yellow-600" />Banco do Brasil - PIX
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">Credenciais para geração de cobranças PIX via API BB</p>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Status PIX:</span>
                    {selectedAccount.bbPixEnabled
                      ? <Badge className="bg-green-100 text-green-800 gap-1"><Wifi className="h-3 w-3" />Habilitado</Badge>
                      : <Badge variant="outline" className="gap-1"><WifiOff className="h-3 w-3" />Desabilitado</Badge>}
                  </div>
                  {selectedAccount.bbClientId && (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="text-sm">Client ID:</span>
                        <span className="text-xs font-mono">{selectedAccount.bbClientId.substring(0, 8)}...</span>
                      </div>
                      {selectedAccount.bbConvenio && (
                        <div className="flex items-center justify-between">
                          <span className="text-sm">Convênio:</span>
                          <span className="text-xs font-mono">{selectedAccount.bbConvenio}</span>
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        <span className="text-sm">Webhook:</span>
                        {selectedAccount.bbWebhookConfigured
                          ? <Badge className="bg-green-100 text-green-800">Configurado</Badge>
                          : <Badge variant="outline">Pendente</Badge>}
                      </div>
                    </>
                  )}
                  <Button variant="outline" size="sm" className="w-full" onClick={() => openEdit(selectedAccount)}>
                    <Key className="h-4 w-4 mr-2" />Configurar Credenciais
                  </Button>
                  {selectedAccount.bbPixEnabled && (
                    <Button variant="outline" size="sm" className="w-full" onClick={() => testBBMutation.mutate(selectedAccount.id)} disabled={testBBMutation.isPending}>
                      {testBBMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Wifi className="h-4 w-4 mr-2" />}
                      Testar Conexão BB
                    </Button>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <FileText className="h-5 w-5 text-green-600" />Boletos de Cobrança
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">Configuração para emissão de boletos via API BB</p>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Emissão de Boletos:</span>
                    {selectedAccount.bbBoletoEnabled
                      ? <Badge className="bg-green-100 text-green-800 gap-1"><Wifi className="h-3 w-3" />Habilitado</Badge>
                      : <Badge variant="outline" className="gap-1"><WifiOff className="h-3 w-3" />Desabilitado</Badge>}
                  </div>
                  {selectedAccount.bbBoletoEnabled && (
                    <>
                      {selectedAccount.bbCarteira && (
                        <div className="text-sm"><span className="text-muted-foreground">Carteira:</span> {selectedAccount.bbCarteira}</div>
                      )}
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        {selectedAccount.bbConvenio && (
                          <div><span className="text-muted-foreground">Convênio:</span> {selectedAccount.bbConvenio}</div>
                        )}
                        {selectedAccount.bbContrato && (
                          <div><span className="text-muted-foreground">Contrato:</span> {selectedAccount.bbContrato}</div>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        {selectedAccount.bbJurosPercentual && (
                          <div><span className="text-muted-foreground">Juros:</span> {selectedAccount.bbJurosPercentual}% a.m.</div>
                        )}
                        {selectedAccount.bbMultaPercentual && (
                          <div><span className="text-muted-foreground">Multa:</span> {selectedAccount.bbMultaPercentual}%</div>
                        )}
                      </div>
                      {(selectedAccount.bbInstrucaoLinha1 || selectedAccount.bbInstrucaoLinha2) && (
                        <div className="text-xs text-muted-foreground border-t pt-2 mt-1">
                          <p className="font-medium text-foreground mb-1">Instruções:</p>
                          {selectedAccount.bbInstrucaoLinha1 && <p>{selectedAccount.bbInstrucaoLinha1}</p>}
                          {selectedAccount.bbInstrucaoLinha2 && <p>{selectedAccount.bbInstrucaoLinha2}</p>}
                          {selectedAccount.bbInstrucaoLinha3 && <p>{selectedAccount.bbInstrucaoLinha3}</p>}
                          {selectedAccount.bbInstrucaoLinha4 && <p>{selectedAccount.bbInstrucaoLinha4}</p>}
                        </div>
                      )}
                    </>
                  )}
                  <Button variant="outline" size="sm" className="w-full" onClick={() => openEdit(selectedAccount)}>
                    <Key className="h-4 w-4 mr-2" />Configurar Boletos
                  </Button>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>

        <Dialog open={showPixDialog} onOpenChange={setShowPixDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Nova Cobrança PIX</DialogTitle>
              <DialogDescription>Gere um QR Code dinâmico para recebimento via PIX (Banco do Brasil)</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Tipo</Label>
                <Select value={pixForm.chargeType} onValueChange={v => setPixForm({ ...pixForm, chargeType: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="imediata">Imediata</SelectItem>
                    <SelectItem value="com_vencimento">Com Vencimento</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div><Label>Valor (R$)</Label><Input type="number" step="0.01" value={pixForm.amount} onChange={e => setPixForm({ ...pixForm, amount: e.target.value })} placeholder="0.00" /></div>
              <div><Label>Nome do Pagador</Label><Input value={pixForm.debtorName} onChange={e => setPixForm({ ...pixForm, debtorName: e.target.value })} /></div>
              <div><Label>CPF/CNPJ do Pagador</Label><Input value={pixForm.debtorDocument} onChange={e => setPixForm({ ...pixForm, debtorDocument: e.target.value })} /></div>
              <div><Label>Descrição</Label><Input value={pixForm.description} onChange={e => setPixForm({ ...pixForm, description: e.target.value })} placeholder="Descrição da cobrança" /></div>
              {pixForm.chargeType === 'imediata' && (
                <div>
                  <Label>Validade (segundos)</Label>
                  <Select value={pixForm.expirationSeconds} onValueChange={v => setPixForm({ ...pixForm, expirationSeconds: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1800">30 minutos</SelectItem>
                      <SelectItem value="3600">1 hora</SelectItem>
                      <SelectItem value="7200">2 horas</SelectItem>
                      <SelectItem value="86400">24 horas</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              {pixForm.chargeType === 'com_vencimento' && (
                <div><Label>Data de Vencimento</Label><Input type="date" value={pixForm.dueDate} onChange={e => setPixForm({ ...pixForm, dueDate: e.target.value })} /></div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowPixDialog(false)}>Cancelar</Button>
              <Button onClick={() => createPixMutation.mutate(pixForm)} disabled={createPixMutation.isPending || !pixForm.amount}>
                {createPixMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Gerar QR Code
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end">
        <div><Label className="text-xs">Instância</Label><InstanceFilter value={instanceId} onChange={setInstanceId} /></div>
        <Button onClick={openCreate} className="ml-auto"><Plus className="w-4 h-4 mr-2" />Nova Conta Financeira</Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-8 w-8 animate-spin" /></div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {accounts.length === 0 ? (
              <div className="col-span-full text-center py-8 text-muted-foreground">Nenhuma conta financeira encontrada</div>
            ) : accounts.map((a: any) => {
              const Icon = typeIcons[a.type] || Landmark;
              return (
                <Card key={a.id} className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => { setSelectedAccount(a); setActiveSubTab('movements'); }}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-lg ${a.type === 'caixa' ? 'bg-green-100' : a.type === 'banco' ? 'bg-blue-100' : 'bg-purple-100'}`}>
                          <Icon className={`h-5 w-5 ${a.type === 'caixa' ? 'text-green-600' : a.type === 'banco' ? 'text-blue-600' : 'text-purple-600'}`} />
                        </div>
                        <div>
                          <p className="font-medium">{a.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {a.bankCode ? `${a.bankCode} - ` : ''}{a.bankName || typeLabels[a.type] || a.type}
                            {a.agency ? ` | Ag: ${a.agency}` : ''}{a.accountNumber ? ` | CC: ${a.accountNumber}` : ''}
                          </p>
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={(e) => { e.stopPropagation(); openEdit(a); }}><Edit className="h-3 w-3" /></Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={(e) => { e.stopPropagation(); if (confirm('Remover esta conta?')) deleteMutation.mutate(a.id); }}><Trash2 className="h-3 w-3 text-red-500" /></Button>
                      </div>
                    </div>
                    <div className="mt-3 flex items-end justify-between">
                      <div>
                        <p className="text-xs text-muted-foreground">Saldo</p>
                        <p className="text-xl font-bold">{formatCurrency(a.balance)}</p>
                      </div>
                      <div className="flex gap-1">
                        {a.bbPixEnabled && <Badge className="bg-yellow-100 text-yellow-800 text-[10px]">PIX BB</Badge>}
                        {a.bbBoletoEnabled && <Badge className="bg-yellow-100 text-yellow-800 text-[10px]">Boleto BB</Badge>}
                        {a.omieInstanceId && <Badge variant="outline" className="text-[10px]">{a.omieInstanceId}</Badge>}
                      </div>
                    </div>
                    {a.pixKey && <p className="text-xs text-muted-foreground mt-1 truncate">PIX: {a.pixKey}</p>}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editItem ? 'Editar Conta Financeira' : 'Nova Conta Financeira'}</DialogTitle>
            <DialogDescription>Preencha os dados da conta corrente e configurações de integração bancária</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="border-b pb-3">
              <h4 className="font-medium text-sm mb-3">Conta Corrente</h4>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Tipo de Conta</Label>
                    <Select value={form.accountSubtype || 'conta_corrente'} onValueChange={v => setForm({ ...form, accountSubtype: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {ACCOUNT_SUBTYPES.map(st => (
                          <SelectItem key={st.value} value={st.value}>{st.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Instituição</Label>
                    <Select value={form.bankCode || ''} onValueChange={handleBankSelect}>
                      <SelectTrigger><SelectValue placeholder="Selecione o banco" /></SelectTrigger>
                      <SelectContent>
                        {BANK_LIST.map(bank => (
                          <SelectItem key={bank.code} value={bank.code}>{bank.code} - {bank.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div><Label>Nome da Conta</Label><Input value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Ex: BB - FILIAL" /></div>
                  <div><Label>Agência</Label><Input value={form.agency || ''} onChange={e => setForm({ ...form, agency: e.target.value })} placeholder="Ex: 4148-3" /></div>
                  <div><Label>Conta Corrente (com dígito)</Label><Input value={form.accountNumber || ''} onChange={e => setForm({ ...form, accountNumber: e.target.value })} placeholder="Ex: 24925-4" /></div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div><Label>Chave PIX</Label><Input value={form.pixKey || ''} onChange={e => setForm({ ...form, pixKey: e.target.value })} placeholder="CPF, CNPJ, e-mail ou telefone" /></div>
                  <div>
                    <Label>Instância Omie</Label>
                    <Select value={form.omieInstanceId || 'none'} onValueChange={v => setForm({ ...form, omieInstanceId: v === 'none' ? '' : v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Nenhuma</SelectItem>
                        <SelectItem value="BSB">BSB</SelectItem>
                        <SelectItem value="GYN">GYN</SelectItem>
                        <SelectItem value="IND">IND</SelectItem>
                        <SelectItem value="SERV">SERV</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Classificação</Label>
                    <Select value={form.type || 'banco'} onValueChange={v => setForm({ ...form, type: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="caixa">Caixa</SelectItem>
                        <SelectItem value="banco">Banco</SelectItem>
                        <SelectItem value="carteira_digital">Carteira Digital</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label>Saldo Inicial (R$)</Label>
                    <Input type="number" step="0.01" value={form.balance ?? ''} onChange={e => setForm({ ...form, balance: e.target.value })} placeholder="0,00" />
                  </div>
                  <div>
                    <Label>Descrição / Observações</Label>
                    <Input value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Observações sobre a conta" />
                  </div>
                  <div className="flex items-end">
                    <label className="flex items-center gap-2 cursor-pointer pb-2">
                      <input type="checkbox" checked={form.isActive !== false} onChange={e => setForm({ ...form, isActive: e.target.checked })} className="rounded" />
                      <span className="text-sm">Conta Ativa</span>
                    </label>
                  </div>
                </div>
              </div>
            </div>

            {form.type === 'banco' && form.bankCode === '001' && (
              <>
                <div className="border-b pb-3">
                  <h4 className="font-medium text-sm mb-3 flex items-center gap-2">
                    <Landmark className="h-4 w-4 text-yellow-600" />
                    Credenciais para integração bancária (API)
                  </h4>
                  <p className="text-xs text-muted-foreground mb-4">Obtenha as credenciais no Portal Developers BB (app.developers.bb.com.br). Cada serviço possui seu par de Client ID / Client Secret.</p>

                  <div className="space-y-4">
                    <div className="border rounded-lg p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={form.bbBoletoEnabled || false} onChange={e => setForm({ ...form, bbBoletoEnabled: e.target.checked })} className="rounded" />
                          <span className="text-sm font-medium">Credenciais da API para integração de <strong>Boletos</strong></span>
                        </label>
                      </div>
                      {form.bbBoletoEnabled && (
                        <div className="grid grid-cols-2 gap-3 pt-1">
                          <div><Label className="text-xs">Client ID</Label><Input value={form.bbClientId || ''} onChange={e => setForm({ ...form, bbClientId: e.target.value })} placeholder="Client ID Boletos" /></div>
                          <div><Label className="text-xs">Client Secret</Label><Input type="password" value={form.bbClientSecret || ''} onChange={e => setForm({ ...form, bbClientSecret: e.target.value })} placeholder="Client Secret Boletos" /></div>
                        </div>
                      )}
                    </div>

                    <div className="border rounded-lg p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={form.bbPixEnabled || false} onChange={e => setForm({ ...form, bbPixEnabled: e.target.checked })} className="rounded" />
                          <span className="text-sm font-medium">Credenciais da API para integração de <strong>Pix</strong></span>
                        </label>
                      </div>
                      {form.bbPixEnabled && (
                        <div className="grid grid-cols-2 gap-3 pt-1">
                          <div><Label className="text-xs">Client ID</Label><Input value={form.bbPixClientId || ''} onChange={e => setForm({ ...form, bbPixClientId: e.target.value })} placeholder="Client ID Pix" /></div>
                          <div><Label className="text-xs">Client Secret</Label><Input type="password" value={form.bbPixClientSecret || ''} onChange={e => setForm({ ...form, bbPixClientSecret: e.target.value })} placeholder="Client Secret Pix" /></div>
                        </div>
                      )}
                    </div>

                    <div className="border rounded-lg p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={!!form.bbPagamentosClientId} onChange={e => { if (!e.target.checked) setForm({ ...form, bbPagamentosClientId: '', bbPagamentosClientSecret: '' }); else setForm({ ...form, bbPagamentosClientId: form.bbPagamentosClientId || ' ' }); }} className="rounded" />
                          <span className="text-sm font-medium">Credenciais da API para integração de <strong>Pagamentos</strong></span>
                        </label>
                      </div>
                      {!!form.bbPagamentosClientId && (
                        <div className="grid grid-cols-2 gap-3 pt-1">
                          <div><Label className="text-xs">Client ID</Label><Input value={form.bbPagamentosClientId?.trim() || ''} onChange={e => setForm({ ...form, bbPagamentosClientId: e.target.value })} placeholder="Client ID Pagamentos" /></div>
                          <div><Label className="text-xs">Client Secret</Label><Input type="password" value={form.bbPagamentosClientSecret || ''} onChange={e => setForm({ ...form, bbPagamentosClientSecret: e.target.value })} placeholder="Client Secret Pagamentos" /></div>
                        </div>
                      )}
                    </div>

                    <div className="border rounded-lg p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={!!form.bbExtratoClientId} onChange={e => { if (!e.target.checked) setForm({ ...form, bbExtratoClientId: '', bbExtratoClientSecret: '' }); else setForm({ ...form, bbExtratoClientId: form.bbExtratoClientId || ' ' }); }} className="rounded" />
                          <span className="text-sm font-medium">Credenciais da API para integração de <strong>Extrato</strong></span>
                        </label>
                      </div>
                      {!!form.bbExtratoClientId && (
                        <div className="grid grid-cols-2 gap-3 pt-1">
                          <div><Label className="text-xs">Client ID</Label><Input value={form.bbExtratoClientId?.trim() || ''} onChange={e => setForm({ ...form, bbExtratoClientId: e.target.value })} placeholder="Client ID Extrato" /></div>
                          <div><Label className="text-xs">Client Secret</Label><Input type="password" value={form.bbExtratoClientSecret || ''} onChange={e => setForm({ ...form, bbExtratoClientSecret: e.target.value })} placeholder="Client Secret Extrato" /></div>
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div><Label>Developer Application Key</Label><Input value={form.bbDevAppKey || ''} onChange={e => setForm({ ...form, bbDevAppKey: e.target.value })} placeholder="gw-dev-app-key" /></div>
                      <div><Label>Convênio</Label><Input value={form.bbConvenio || ''} onChange={e => setForm({ ...form, bbConvenio: e.target.value })} placeholder="Número do convênio BB" /></div>
                    </div>
                  </div>
                </div>

                {form.bbBoletoEnabled && (
                  <div className="border-b pb-3">
                    <h4 className="font-medium text-sm mb-3 flex items-center gap-2">
                      <FileText className="h-4 w-4 text-green-600" />
                      Boletos de Cobrança
                    </h4>

                    <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4">
                      <div className="grid grid-cols-3 gap-3 text-sm">
                        <div>
                          <Label className="text-xs text-green-700 font-medium">Carteira</Label>
                          <Select value={form.bbCarteira || ''} onValueChange={v => setForm({ ...form, bbCarteira: v })}>
                            <SelectTrigger className="bg-white"><SelectValue placeholder="Selecione a carteira" /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="17">17 - Cobrança Direta Especial - Com Registro (019)</SelectItem>
                              <SelectItem value="11">11 - Cobrança Simples</SelectItem>
                              <SelectItem value="12">12 - Cobrança Indexada</SelectItem>
                              <SelectItem value="31">31 - Cobrança Caucionada</SelectItem>
                              <SelectItem value="51">51 - Cobrança Descontada</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <Label className="text-xs text-green-700 font-medium">Convênio</Label>
                          <Input value={form.bbConvenio || ''} readOnly className="bg-gray-50 text-sm" placeholder="Definido acima" />
                        </div>
                        <div>
                          <Label className="text-xs text-green-700 font-medium">Contrato</Label>
                          <Input value={form.bbContrato || ''} onChange={e => setForm({ ...form, bbContrato: e.target.value })} placeholder="Número do contrato" className="text-sm" />
                        </div>
                      </div>
                      <p className="text-[10px] text-green-600 mt-1">Obrigatórias para a cobrança bancária deste banco</p>
                    </div>

                    <div className="mb-4">
                      <p className="text-sm font-medium mb-2">Juros e Multa para o Boleto <span className="text-xs text-muted-foreground font-normal">e para a integração bancária</span></p>
                      <div className="grid grid-cols-4 gap-3">
                        <div>
                          <Label className="text-xs">% de Juros (ao mês)</Label>
                          <Input type="number" step="0.01" value={form.bbJurosPercentual || ''} onChange={e => setForm({ ...form, bbJurosPercentual: e.target.value })} placeholder="3,00" className="text-sm" />
                        </div>
                        <div>
                          <Label className="text-xs">% de Multa</Label>
                          <Input type="number" step="0.01" value={form.bbMultaPercentual || ''} onChange={e => setForm({ ...form, bbMultaPercentual: e.target.value })} placeholder="2,00" className="text-sm" />
                        </div>
                        <div>
                          <Label className="text-xs">Dias para Compensação</Label>
                          <Select value={form.bbDiasCompensacao || 'nenhum'} onValueChange={v => setForm({ ...form, bbDiasCompensacao: v })}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="nenhum">Nenhum</SelectItem>
                              <SelectItem value="1">1 dia</SelectItem>
                              <SelectItem value="2">2 dias</SelectItem>
                              <SelectItem value="3">3 dias</SelectItem>
                              <SelectItem value="5">5 dias</SelectItem>
                              <SelectItem value="10">10 dias</SelectItem>
                              <SelectItem value="15">15 dias</SelectItem>
                              <SelectItem value="29">29 dias</SelectItem>
                              <SelectItem value="30">30 dias</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <Label className="text-xs">Senha nos Boletos</Label>
                          <Select value={form.bbSenhaBoletos || 'nenhuma'} onValueChange={v => setForm({ ...form, bbSenhaBoletos: v })}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="nenhuma">Nenhuma Senha</SelectItem>
                              <SelectItem value="cpf_cnpj">CPF/CNPJ do Pagador</SelectItem>
                              <SelectItem value="nosso_numero">Nosso Número</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>

                    <div>
                      <p className="text-sm font-medium mb-2">Instruções para o Boleto <span className="text-xs text-muted-foreground font-normal">e para a integração bancária</span></p>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label className="text-xs">Linha 1</Label>
                          <Input value={form.bbInstrucaoLinha1 || ''} onChange={e => setForm({ ...form, bbInstrucaoLinha1: e.target.value })} placeholder="Sr. Caixa, receber até 29 dias após o vencimento." className="text-sm" />
                        </div>
                        <div>
                          <Label className="text-xs">Linha 2</Label>
                          <Input value={form.bbInstrucaoLinha2 || ''} onChange={e => setForm({ ...form, bbInstrucaoLinha2: e.target.value })} placeholder="Após o vencimento multa de 2%, juros de 3%a.m." className="text-sm" />
                        </div>
                        <div>
                          <Label className="text-xs">Linha 3</Label>
                          <Input value={form.bbInstrucaoLinha3 || ''} onChange={e => setForm({ ...form, bbInstrucaoLinha3: e.target.value })} className="text-sm" />
                        </div>
                        <div>
                          <Label className="text-xs">Linha 4</Label>
                          <Input value={form.bbInstrucaoLinha4 || ''} onChange={e => setForm({ ...form, bbInstrucaoLinha4: e.target.value })} className="text-sm" />
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancelar</Button>
            <Button onClick={handleSave} disabled={createMutation.isPending || updateMutation.isPending}>
              {(createMutation.isPending || updateMutation.isPending) && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {editItem ? 'Salvar Credenciais' : 'Criar Conta'}
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
  const [year, setYear] = useState(new Date().getFullYear());

  const buildUrl = () => {
    const p = new URLSearchParams();
    if (instanceId) p.set('instanceId', instanceId);
    p.set('year', year.toString());
    return `/api/financial/dre?${p.toString()}`;
  };

  const { data: dre, isLoading } = useQuery<any>({
    queryKey: ['/api/financial/dre', instanceId, year],
    queryFn: () => fetch(buildUrl(), { credentials: 'include' }).then(r => r.json()),
  });

  const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const yearOptions = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i);

  const fmtNum = (v: number) => {
    if (v === 0) return '-';
    return v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  };

  const fmtPct = (v: number) => {
    if (isNaN(v) || !isFinite(v)) return '-';
    return `${v.toFixed(1)}%`;
  };

  type RowStyle = 'normal' | 'deduction' | 'header' | 'total' | 'highlight' | 'indicator' | 'separator';

  const renderRow = (label: string, monthly: number[], total: number, avPct: number, style: RowStyle = 'normal') => {
    const baseClass = {
      normal: 'text-xs',
      deduction: 'text-xs',
      header: 'text-xs font-semibold bg-muted/30',
      total: 'text-xs font-bold border-t border-b bg-muted/50',
      highlight: 'text-xs font-bold bg-green-50 dark:bg-green-950/30 border-t-2 border-b',
      indicator: 'text-xs italic text-muted-foreground',
      separator: 'h-2',
    }[style];

    if (style === 'separator') {
      return <tr key={`sep-${label}-${Math.random()}`} className="h-2"><td colSpan={15}></td></tr>;
    }

    if (style === 'header' && monthly.length === 0) {
      return (
        <tr key={label} className="text-xs font-semibold bg-muted/30">
          <td colSpan={15} className="sticky left-0 bg-muted/30 px-2 py-1.5 z-10">{label}</td>
        </tr>
      );
    }

    const textColor = (v: number) => {
      if (style === 'indicator') return '';
      if (style === 'highlight' && v < 0) return 'text-red-600';
      if (style === 'highlight' && v > 0) return 'text-green-700';
      if (style === 'total' && v < 0) return 'text-red-600';
      return '';
    };

    return (
      <tr key={label} className={baseClass}>
        <td className="sticky left-0 bg-background px-2 py-1 whitespace-nowrap border-r min-w-[250px] max-w-[300px] truncate z-10">
          {style === 'deduction' ? `(-) ${label}` : label}
        </td>
        {monthly.map((v, i) => (
          <td key={i} className={`px-2 py-1 text-right whitespace-nowrap tabular-nums ${textColor(v)}`}>
            {fmtNum(v)}
          </td>
        ))}
        <td className={`px-2 py-1 text-right whitespace-nowrap tabular-nums font-medium border-l ${textColor(total)}`}>
          {fmtNum(total)}
        </td>
        <td className={`px-2 py-1 text-right whitespace-nowrap tabular-nums border-l ${textColor(avPct)}`}>
          {fmtPct(avPct)}
        </td>
      </tr>
    );
  };

  const renderIndicatorRow = (label: string, monthly: number[], totalPct: number) => {
    return (
      <tr key={label} className="text-xs italic text-muted-foreground">
        <td className="sticky left-0 bg-background px-2 py-1 whitespace-nowrap border-r min-w-[250px] z-10">{label}</td>
        {monthly.map((v, i) => (
          <td key={i} className="px-2 py-1 text-right whitespace-nowrap tabular-nums">{fmtPct(v)}</td>
        ))}
        <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums border-l"></td>
        <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums font-medium border-l">{fmtPct(totalPct)}</td>
      </tr>
    );
  };

  const computeAV = (total: number, recLiqTotal: number) => recLiqTotal !== 0 ? (total / recLiqTotal) * 100 : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end">
        <div><Label className="text-xs">Instância</Label><InstanceFilter value={instanceId} onChange={setInstanceId} /></div>
        <div>
          <Label className="text-xs">Ano</Label>
          <Select value={year.toString()} onValueChange={v => setYear(parseInt(v))}>
            <SelectTrigger className="w-[100px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {yearOptions.map(y => <SelectItem key={y} value={y.toString()}>{y}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-8 w-8 animate-spin" /></div>
      ) : dre?.computed ? (() => {
        const c = dre.computed;
        const rl = c.receitaLiquida.total || 1;
        const lines = dre.lines || [];
        const getGroupLines = (group: string) => lines.filter((l: any) => l.dreGroup === group);

        const pctMonthly = (monthly: number[], base: number[]) =>
          monthly.map((v: number, i: number) => base[i] !== 0 ? (v / base[i]) * 100 : 0);

        return (
          <div className="border rounded-lg overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted sticky top-0 z-20">
                <tr className="text-xs font-semibold">
                  <th className="sticky left-0 bg-muted px-2 py-2 text-left border-r min-w-[250px] z-30">Descrição</th>
                  {months.map(m => <th key={m} className="px-2 py-2 text-right whitespace-nowrap min-w-[75px]">{m}</th>)}
                  <th className="px-2 py-2 text-right whitespace-nowrap border-l min-w-[85px]">Total</th>
                  <th className="px-2 py-2 text-right whitespace-nowrap border-l min-w-[60px]">AV %</th>
                </tr>
              </thead>
              <tbody>
                {renderRow('Receita Bruta de Vendas', c.receitaBruta.monthly, c.receitaBruta.total, computeAV(c.receitaBruta.total, rl), 'total')}
                {renderRow('Devoluções/Descontos', c.devolucoes.monthly, c.devolucoes.total, computeAV(c.devolucoes.total, rl), 'deduction')}
                {renderRow('Impostos sobre Vendas (ICMS, PIS/COFINS, ISS)', c.impostos.monthly, c.impostos.total, computeAV(c.impostos.total, rl), 'deduction')}
                {renderRow('Receita Líquida', c.receitaLiquida.monthly, c.receitaLiquida.total, 100, 'highlight')}

                {renderRow('', new Array(12).fill(0), 0, 0, 'separator')}

                {renderRow('(-) CPV', [], 0, 0, 'header')}
                {getGroupLines('cpv').map((l: any) =>
                  renderRow(l.name, l.monthly, l.total, computeAV(l.total, rl), 'deduction')
                )}
                {renderRow('CPV Total', c.cpvTotal.monthly, c.cpvTotal.total, computeAV(c.cpvTotal.total, rl), 'total')}
                {renderRow('Lucro Bruto', c.lucroBruto.monthly, c.lucroBruto.total, computeAV(c.lucroBruto.total, rl), 'highlight')}

                {renderRow('', new Array(12).fill(0), 0, 0, 'separator')}

                {renderRow('(-) Despesas Comerciais', [], 0, 0, 'header')}
                {getGroupLines('despesas_comerciais').map((l: any) =>
                  renderRow(l.name, l.monthly, l.total, computeAV(l.total, rl), 'deduction')
                )}
                {renderRow('Despesas Comerciais Total', c.despesasComerciais.monthly, c.despesasComerciais.total, computeAV(c.despesasComerciais.total, rl), 'total')}

                {renderRow('(-) Despesas Administrativas', [], 0, 0, 'header')}
                {getGroupLines('despesas_administrativas').map((l: any) =>
                  renderRow(l.name, l.monthly, l.total, computeAV(l.total, rl), 'deduction')
                )}
                {renderRow('Despesas Administrativas Total', c.despesasAdministrativas.monthly, c.despesasAdministrativas.total, computeAV(c.despesasAdministrativas.total, rl), 'total')}

                {renderRow('(-) Despesas Gerais', [], 0, 0, 'header')}
                {getGroupLines('despesas_gerais').map((l: any) =>
                  renderRow(l.name, l.monthly, l.total, computeAV(l.total, rl), 'deduction')
                )}
                {renderRow('Despesas Gerais Total', c.despesasGerais.monthly, c.despesasGerais.total, computeAV(c.despesasGerais.total, rl), 'total')}

                {renderRow('(-) Outras Receitas/Despesas Operacionais', c.outrasReceitasDespesas.monthly, c.outrasReceitasDespesas.total, computeAV(c.outrasReceitasDespesas.total, rl), 'deduction')}
                {renderRow('Despesas Operacionais Total', c.despesasOperacionaisTotal.monthly, c.despesasOperacionaisTotal.total, computeAV(c.despesasOperacionaisTotal.total, rl), 'total')}
                {renderRow('(-) Depreciação e Amortização', c.depreciacao.monthly, c.depreciacao.total, computeAV(c.depreciacao.total, rl), 'deduction')}
                {renderRow('EBITDA', c.ebitda.monthly, c.ebitda.total, computeAV(c.ebitda.total, rl), 'highlight')}
                {renderRow('Resultado Operacional (EBIT)', c.ebit.monthly, c.ebit.total, computeAV(c.ebit.total, rl), 'highlight')}

                {renderRow('', new Array(12).fill(0), 0, 0, 'separator')}

                {renderRow('(+/-) Resultado Financeiro', [], 0, 0, 'header')}
                {renderRow('(+) Receitas Financeiras', c.receitasFinanceiras.monthly, c.receitasFinanceiras.total, computeAV(c.receitasFinanceiras.total, rl), 'normal')}
                {renderRow('(-) Despesas Financeiras (juros, tarifas)', c.despesasFinanceiras.monthly, c.despesasFinanceiras.total, computeAV(c.despesasFinanceiras.total, rl), 'deduction')}
                {renderRow('Resultado Financeiro Total', c.resultadoFinanceiro.monthly, c.resultadoFinanceiro.total, computeAV(c.resultadoFinanceiro.total, rl), 'total')}

                {renderRow('', new Array(12).fill(0), 0, 0, 'separator')}

                {renderRow('Resultado Antes do IR/CSLL', c.resultadoAntesIR.monthly, c.resultadoAntesIR.total, computeAV(c.resultadoAntesIR.total, rl), 'total')}
                {renderRow('(-) IRPJ/CSLL', c.irpjCsll.monthly, c.irpjCsll.total, computeAV(c.irpjCsll.total, rl), 'deduction')}
                {renderRow('Lucro/Prejuízo Líquido', c.lucroLiquido.monthly, c.lucroLiquido.total, computeAV(c.lucroLiquido.total, rl), 'highlight')}

                {(c.unclassifiedReceivables.total > 0 || c.unclassifiedPayables.total > 0) && (
                  <>
                    {renderRow('', new Array(12).fill(0), 0, 0, 'separator')}
                    {renderRow('⚠ Receitas não classificadas', c.unclassifiedReceivables.monthly, c.unclassifiedReceivables.total, 0, 'normal')}
                    {renderRow('⚠ Despesas não classificadas', c.unclassifiedPayables.monthly, c.unclassifiedPayables.total, 0, 'normal')}
                  </>
                )}

                {renderRow('', new Array(12).fill(0), 0, 0, 'separator')}
                <tr className="text-xs font-bold bg-muted/30"><td colSpan={15} className="px-2 py-2 sticky left-0 bg-muted/30 z-10">Indicadores</td></tr>
                {renderIndicatorRow('Margem Bruta (%)', pctMonthly(c.lucroBruto.monthly, c.receitaLiquida.monthly), c.receitaLiquida.total !== 0 ? (c.lucroBruto.total / c.receitaLiquida.total) * 100 : 0)}
                {renderIndicatorRow('Margem EBITDA (%)', pctMonthly(c.ebitda.monthly, c.receitaLiquida.monthly), c.receitaLiquida.total !== 0 ? (c.ebitda.total / c.receitaLiquida.total) * 100 : 0)}
                {renderIndicatorRow('Margem Líquida (%)', pctMonthly(c.lucroLiquido.monthly, c.receitaLiquida.monthly), c.receitaLiquida.total !== 0 ? (c.lucroLiquido.total / c.receitaLiquida.total) * 100 : 0)}
                {renderIndicatorRow('CPV % da Receita', pctMonthly(c.cpvTotal.monthly, c.receitaLiquida.monthly), c.receitaLiquida.total !== 0 ? (c.cpvTotal.total / c.receitaLiquida.total) * 100 : 0)}
                {renderIndicatorRow('Opex % da Receita', pctMonthly(c.despesasOperacionaisTotal.monthly, c.receitaLiquida.monthly), c.receitaLiquida.total !== 0 ? (c.despesasOperacionaisTotal.total / c.receitaLiquida.total) * 100 : 0)}
              </tbody>
            </table>
          </div>
        );
      })() : (
        <div className="text-center text-muted-foreground py-8">Nenhum dado disponível para o período</div>
      )}
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
const TAB_CONFIG: Record<string, { label: string; icon: any }> = {
  receivables: { label: 'Contas a Receber', icon: CreditCard },
  payables: { label: 'Contas a Pagar', icon: Banknote },
  overdue: { label: 'Débitos Vencidos', icon: AlertTriangle },
  blocked: { label: 'Pedidos Bloqueados', icon: Ban },
  chart: { label: 'Plano de Contas', icon: BarChart3 },
  accounts: { label: 'Contas Financeiras', icon: CreditCard },
  dre: { label: 'DRE', icon: TrendingUp },
  xml: { label: 'XMLs', icon: FileCode },
  sped: { label: 'SPED Fiscal', icon: Database },
};

export default function Financial() {
  const { user } = useAuth();
  const isFullAccess = user?.role && ['admin', 'coordinator', 'administrative'].includes(user.role);
  const canViewReceivables = isFullAccess || (!!user?.role && ['vendedor', 'telemarketing'].includes(user.role));
  // Boleto bancário no Contas a Receber: liberado para todos os vendedores
  // (externos e telemarketing), mesmo em modo leitura. Demais ações seguem admin.
  const canEmitBoleto = !!user?.role && ['vendedor', 'telemarketing'].includes(user.role);
  const searchString = useSearch();
  const urlTab = new URLSearchParams(searchString).get('tab');
  const defaultTab = isFullAccess ? 'receivables' : 'overdue';
  const [activeTab, setActiveTab] = useState(urlTab || defaultTab);
  const directTab = !!urlTab;

  useEffect(() => {
    if (urlTab && urlTab !== activeTab) {
      setActiveTab(urlTab);
    }
  }, [urlTab]);

  const tabConfig = TAB_CONFIG[activeTab];
  const TabIcon = tabConfig?.icon || DollarSign;

  const renderTabContent = () => {
    switch (activeTab) {
      case 'receivables': return canViewReceivables ? <ReceivablesTab readOnly={!isFullAccess} canBoleto={canEmitBoleto} /> : null;
      case 'payables': return isFullAccess ? <PayablesTab /> : null;
      case 'overdue': return <OverdueDebtsManagement />;
      case 'blocked': return <BlockedOrdersManagement user={user as any} />;
      case 'chart': return isFullAccess ? <ChartOfAccountsTab /> : null;
      case 'accounts': return isFullAccess ? <FinancialAccountsTab /> : null;
      case 'dre': return isFullAccess ? <DRETab /> : null;
      case 'xml': return isFullAccess ? <XMLsTab /> : null;
      case 'sped': return isFullAccess ? <SPEDTab /> : null;
      default: return null;
    }
  };

  if (directTab) {
    return (
      <div className="p-6 space-y-6">
        <BackToDashboardButton />
        <div className="flex items-center gap-3">
          <TabIcon className="h-8 w-8 text-green-600" />
          <div>
            <h1 className="text-3xl font-bold">{tabConfig?.label || 'Financeiro'}</h1>
          </div>
        </div>
        {renderTabContent()}
      </div>
    );
  }

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
          {isFullAccess && <TabsTrigger value="receivables" className="gap-1"><CreditCard className="h-4 w-4" />Contas a Receber</TabsTrigger>}
          {isFullAccess && <TabsTrigger value="payables" className="gap-1"><Banknote className="h-4 w-4" />Contas a Pagar</TabsTrigger>}
          {isFullAccess && <TabsTrigger value="pix-nao-identificados" className="gap-1"><QrCode className="h-4 w-4" />PIX s/ Identificação</TabsTrigger>}
          {isFullAccess && <TabsTrigger value="classificacao-dre" className="gap-1"><Landmark className="h-4 w-4" />Classificação DRE</TabsTrigger>}
          <TabsTrigger value="overdue" className="gap-1"><AlertTriangle className="h-4 w-4" />Débitos Vencidos</TabsTrigger>
          <TabsTrigger value="blocked" className="gap-1"><Ban className="h-4 w-4" />Pedidos Bloqueados</TabsTrigger>
          {isFullAccess && <TabsTrigger value="chart" className="gap-1"><BarChart3 className="h-4 w-4" />Plano de Contas</TabsTrigger>}
          {isFullAccess && <TabsTrigger value="accounts" className="gap-1"><CreditCard className="h-4 w-4" />Contas Financeiras</TabsTrigger>}
          {isFullAccess && <TabsTrigger value="dre" className="gap-1"><TrendingUp className="h-4 w-4" />DRE</TabsTrigger>}
          {isFullAccess && <TabsTrigger value="xml" className="gap-1"><FileCode className="h-4 w-4" />XMLs</TabsTrigger>}
          {isFullAccess && <TabsTrigger value="sped" className="gap-1"><Database className="h-4 w-4" />SPED Fiscal</TabsTrigger>}
        </TabsList>

        {isFullAccess && <TabsContent value="receivables"><ReceivablesTab /></TabsContent>}
        {isFullAccess && <TabsContent value="payables"><PayablesTab /></TabsContent>}
        {isFullAccess && <TabsContent value="pix-nao-identificados"><PixNaoIdentificadosTab /></TabsContent>}
        {isFullAccess && <TabsContent value="classificacao-dre"><ClassificacaoTab /></TabsContent>}
        <TabsContent value="overdue"><OverdueDebtsManagement /></TabsContent>
        <TabsContent value="blocked"><BlockedOrdersManagement user={user as any} /></TabsContent>
        {isFullAccess && <TabsContent value="chart"><ChartOfAccountsTab /></TabsContent>}
        {isFullAccess && <TabsContent value="accounts"><FinancialAccountsTab /></TabsContent>}
        {isFullAccess && <TabsContent value="dre"><DRETab /></TabsContent>}
        {isFullAccess && <TabsContent value="xml"><XMLsTab /></TabsContent>}
        {isFullAccess && <TabsContent value="sped"><SPEDTab /></TabsContent>}
      </Tabs>
    </div>
  );
}
