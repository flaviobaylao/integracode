// ============================================================================
// MÓDULO INDÚSTRIA 2.0 — formato 1.0 completo + melhorias (18/ago/2026)
// Abas: Matéria-Prima · Receitas · Ordens de Produção · Estoque Produto Acabado
// Backend: /api/industria/* (industria-routes.ts) + /api/inventory/* (lotes).
// Melhorias sobre o 1.0: finalização integrada ao estoque de produto acabado
// (inventory_lots, consumido pela NF-e), polpa produzida entra no estoque de
// matéria-prima automaticamente, CMV calculado ao vivo na finalização.
// ============================================================================
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import RecipesEditor from '@/components/RecipesEditor';
import BackToDashboardButton from '@/components/BackToDashboardButton';
import {
  Factory, ClipboardList, FileText, History, Search, Plus, Package,
  CheckCircle2, AlertTriangle, Loader2, Pencil, Trash2, X, RefreshCw,
  ArrowDownCircle, PlayCircle, ExternalLink, FlaskConical,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const CATEGORIES = [
  { value: 'insumo', label: 'Insumo' },
  { value: 'fruta', label: 'Fruta' },
  { value: 'concentrado', label: 'Concentrado' },
  { value: 'polpa', label: 'Polpa' },
  { value: 'tampa', label: 'Tampa' },
  { value: 'garrafa', label: 'Garrafa' },
  { value: 'rotulo', label: 'Rótulo' },
  { value: 'outros', label: 'Outros' },
];
const UNITS = ['kg', 'gramas', 'litro', 'unidade', 'caixa', 'rolo', 'pacote'];
const MOV_TYPES = [
  { value: 'entrada', label: 'Entrada' },
  { value: 'entrada_compra', label: 'Entrada (Compra)' },
  { value: 'saida', label: 'Saída' },
  { value: 'saida_producao', label: 'Saída (Produção)' },
  { value: 'ajuste', label: 'Ajuste (informe o estoque final)' },
  { value: 'perda', label: 'Perda' },
  { value: 'devolucao', label: 'Devolução' },
];
const MOV_LABEL: Record<string, string> = {
  entrada: 'Entrada', entrada_compra: 'Entrada (Compra)', saida: 'Saída',
  saida_producao: 'Saída (Produção)', ajuste: 'Ajuste', perda: 'Perda', devolucao: 'Devolução',
};
const ORDER_STATUS: Record<string, { label: string; cls: string }> = {
  planejada: { label: 'Planejada', cls: 'bg-blue-100 text-blue-700 hover:bg-blue-100' },
  em_producao: { label: 'Em Produção', cls: 'bg-yellow-100 text-yellow-700 hover:bg-yellow-100' },
  finalizada: { label: 'Finalizada', cls: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' },
  cancelada: { label: 'Cancelada', cls: 'bg-gray-200 text-gray-600 hover:bg-gray-200' },
};

const n = (v: any): number => { const x = Number(String(v ?? '').replace(',', '.')); return isFinite(x) ? x : 0; };
const fmtQty = (v: any) => n(v).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const fmtBRL = (v: any) => n(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDate = (v: any) => {
  if (!v) return '-';
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('pt-BR');
};
const fmtDateTime = (v: any) => {
  if (!v) return '-';
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
};
const jfetch = async (url: string, opts: any = {}) => {
  const r = await fetch(url, { credentials: 'include', headers: opts.body ? { 'Content-Type': 'application/json' } : undefined, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(j?.error || j?.message || `Falha (${r.status})`);
  return j;
};

// ===========================================================================
// ABA 1 — MATÉRIA-PRIMA
// ===========================================================================
type Material = any;

function MateriaPrimaTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState<string | null>(null);
  const [matDialog, setMatDialog] = useState<any>(null);      // {} = novo, material = editar
  const [movDialog, setMovDialog] = useState<Material | null>(null);
  const [histDialog, setHistDialog] = useState<Material | 'all' | null>(null);
  const [saving, setSaving] = useState(false);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['/api/industria/raw-materials'],
    queryFn: () => jfetch('/api/industria/raw-materials'),
  });
  const materials: Material[] = data?.materials || [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['/api/industria/raw-materials'] });
    qc.invalidateQueries({ queryKey: ['/api/industria/movements'] });
  };

  const cards = useMemo(() => CATEGORIES.map((c) => {
    const list = materials.filter((m) => (m.category || 'outros') === c.value);
    return {
      ...c,
      count: list.length,
      qty: list.reduce((s, m) => s + n(m.quantity), 0),
      value: list.reduce((s, m) => s + n(m.quantity) * n(m.unit_cost), 0),
      low: list.filter((m) => n(m.min_quantity) > 0 && n(m.quantity) < n(m.min_quantity)).length,
    };
  }), [materials]);

  const filtered = useMemo(() => {
    let list = materials;
    if (catFilter) list = list.filter((m) => (m.category || 'outros') === catFilter);
    if (search.trim()) {
      const s = search.toLowerCase();
      list = list.filter((m) => [m.name, m.code, m.supplier].some((v) => String(v ?? '').toLowerCase().includes(s)));
    }
    return list;
  }, [materials, search, catFilter]);

  const saveMaterial = async (form: any) => {
    if (!String(form.name || '').trim()) { toast({ title: 'Nome é obrigatório', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      if (form.id) {
        await jfetch(`/api/industria/raw-materials/${form.id}`, { method: 'PATCH', body: JSON.stringify(form) });
        toast({ title: 'Material atualizado', description: form.name });
      } else {
        await jfetch('/api/industria/raw-materials', { method: 'POST', body: JSON.stringify(form) });
        toast({ title: 'Material cadastrado com sucesso', description: form.name });
      }
      setMatDialog(null); invalidate();
    } catch (e: any) { toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' }); }
    finally { setSaving(false); }
  };

  const removeMaterial = async (m: Material) => {
    if (!window.confirm(`Excluir o material "${m.name}"? O histórico de movimentações será excluído junto.`)) return;
    try {
      await jfetch(`/api/industria/raw-materials/${m.id}`, { method: 'DELETE' });
      toast({ title: 'Material excluído', description: m.name });
      invalidate();
    } catch (e: any) { toast({ title: 'Erro ao excluir', description: String(e.message || e), variant: 'destructive' }); }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
        {cards.map((c) => (
          <Card key={c.value}
            className={`cursor-pointer ${catFilter === c.value ? 'ring-2 ring-emerald-500' : ''}`}
            onClick={() => setCatFilter(catFilter === c.value ? null : c.value)}>
            <CardContent className="p-3 text-center">
              <p className="text-xs text-gray-500">{c.label}</p>
              <p className="text-xl font-bold">{c.count}</p>
              <p className="text-[10px] text-gray-400">{fmtQty(c.qty)} un · {fmtBRL(c.value)}</p>
              {c.low > 0 && <Badge className="mt-1 bg-red-500 text-white hover:bg-red-500 text-[10px]">{c.low} baixo</Badge>}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
          <Input placeholder="Buscar material..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 w-[260px]" />
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
        <span className="text-sm text-gray-500">{isLoading ? 'Carregando...' : `${filtered.length} de ${materials.length} materiais`}</span>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => setHistDialog('all')}>
          <History className="h-4 w-4 mr-1" /> Ver Movimentações
        </Button>
        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => setMatDialog({})}>
          <Plus className="h-4 w-4 mr-1" /> Novo Material
        </Button>
      </div>

      <div className="border rounded-lg overflow-auto max-h-[65vh]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Material</TableHead>
              <TableHead>Categoria</TableHead>
              <TableHead>Unidade</TableHead>
              <TableHead className="text-right">Estoque</TableHead>
              <TableHead className="text-right">Mínimo</TableHead>
              <TableHead className="text-right">Custo Unit.</TableHead>
              <TableHead>Fornecedor</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((m) => {
              const low = n(m.min_quantity) > 0 && n(m.quantity) < n(m.min_quantity);
              return (
                <TableRow key={m.id} className={m.is_active === false ? 'opacity-50' : ''}>
                  <TableCell className="font-medium">
                    {m.name} {m.code && <span className="text-xs text-gray-400">({m.code})</span>}
                    {m.is_active === false && <Badge variant="secondary" className="ml-1 text-[10px]">inativo</Badge>}
                  </TableCell>
                  <TableCell><Badge variant="outline" className="capitalize">{m.category || 'outros'}</Badge></TableCell>
                  <TableCell>{m.unit || '-'}</TableCell>
                  <TableCell className={`text-right ${low || n(m.quantity) < 0 ? 'text-red-600 font-semibold' : ''}`}>{fmtQty(m.quantity)}</TableCell>
                  <TableCell className="text-right">{fmtQty(m.min_quantity)}</TableCell>
                  <TableCell className="text-right">{fmtBRL(m.unit_cost)}</TableCell>
                  <TableCell>{m.supplier || '-'}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button variant="ghost" size="sm" title="Movimentar estoque (entrada/saída)" onClick={() => setMovDialog(m)}>
                      <ArrowDownCircle className="h-4 w-4 text-emerald-600" />
                    </Button>
                    <Button variant="ghost" size="sm" title="Histórico do material" onClick={() => setHistDialog(m)}>
                      <History className="h-4 w-4 text-blue-500" />
                    </Button>
                    <Button variant="ghost" size="sm" title="Editar" onClick={() => setMatDialog(m)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" title="Excluir" className="text-red-500 hover:text-red-600" onClick={() => removeMaterial(m)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            {!isLoading && filtered.length === 0 && (
              <TableRow><TableCell colSpan={8} className="text-center text-gray-400 py-8">Nenhum material cadastrado</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {matDialog != null && <MaterialDialog material={matDialog} onClose={() => setMatDialog(null)} onSave={saveMaterial} saving={saving} />}
      {movDialog && <MovementDialog material={movDialog} onClose={() => setMovDialog(null)} onDone={() => { setMovDialog(null); invalidate(); }} />}
      {histDialog && <MovementsDialog target={histDialog} onClose={() => setHistDialog(null)} />}
    </div>
  );
}

function MaterialDialog({ material, onClose, onSave, saving }: any) {
  const isNew = !material.id;
  const [f, setF] = useState<any>({
    id: material.id || null,
    name: material.name || '', code: material.code || '',
    category: material.category || 'outros', unit: material.unit || 'unidade',
    quantity: material.quantity != null ? String(material.quantity) : '0',
    min_quantity: material.min_quantity != null ? String(material.min_quantity) : '0',
    unit_cost: material.unit_cost != null ? String(material.unit_cost) : '0',
    supplier: material.supplier || '', instance_name: material.instance_name || 'IND',
    description: material.description || '', is_active: material.is_active !== false,
  });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{isNew ? 'Novo Material' : 'Editar Material'}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>Nome *</Label><Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Ex: Morango Polpa" /></div>
            <div className="space-y-1.5"><Label>Código</Label><Input value={f.code} onChange={(e) => set('code', e.target.value)} placeholder="Ex: MP-001" /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Categoria</Label>
              <Select value={f.category} onValueChange={(v) => set('category', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{CATEGORIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Unidade</Label>
              <Select value={f.unit} onValueChange={(v) => set('unit', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {isNew && <div className="space-y-1.5"><Label>Quantidade Inicial</Label><Input inputMode="decimal" value={f.quantity} onChange={(e) => set('quantity', e.target.value)} /></div>}
            <div className="space-y-1.5"><Label>Estoque Mínimo</Label><Input inputMode="decimal" value={f.min_quantity} onChange={(e) => set('min_quantity', e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Custo Unitário (R$)</Label><Input inputMode="decimal" value={f.unit_cost} onChange={(e) => set('unit_cost', e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>Fornecedor</Label><Input value={f.supplier} onChange={(e) => set('supplier', e.target.value)} placeholder="Nome do fornecedor" /></div>
            <div className="space-y-1.5"><Label>Instância</Label><Input value={f.instance_name} onChange={(e) => set('instance_name', e.target.value)} /></div>
          </div>
          <div className="space-y-1.5"><Label>Descrição</Label><Textarea rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="Observações sobre o material" /></div>
          {!isNew && (
            <div className="flex items-center gap-2">
              <Switch checked={f.is_active} onCheckedChange={(v) => set('is_active', v)} id="mat-active" />
              <Label htmlFor="mat-active">Material ativo</Label>
            </div>
          )}
          {!isNew && <p className="text-xs text-gray-400">O estoque só muda por movimentação (entrada/saída/ajuste) — use o botão de movimentar na lista.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={() => onSave(f)} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}{isNew ? 'Cadastrar' : 'Salvar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MovementDialog({ material, onClose, onDone }: any) {
  const { toast } = useToast();
  const [type, setType] = useState('entrada');
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!(n(qty) > 0) && !(type === 'ajuste' && n(qty) >= 0)) { toast({ title: 'Quantidade inválida', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      const j = await jfetch(`/api/industria/raw-materials/${material.id}/movement`, {
        method: 'POST',
        body: JSON.stringify({ type, quantity: qty, unit_cost: cost === '' ? null : cost, notes }),
      });
      toast({ title: 'Movimentação registrada', description: `${material.name}: ${MOV_LABEL[type]} — estoque ${fmtQty(j.material?.quantity)}` });
      if (j.negativo) toast({ title: 'Atenção: estoque negativo', description: material.name, variant: 'destructive' });
      onDone();
    } catch (e: any) { toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' }); }
    finally { setSaving(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Movimentação: {material.name}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-gray-500">Estoque atual: <b>{fmtQty(material.quantity)} {material.unit}</b> · Custo unit.: <b>{fmtBRL(material.unit_cost)}</b></p>
          <div className="space-y-1.5">
            <Label>Tipo de Movimentação</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{MOV_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{type === 'ajuste' ? 'Estoque final (após o ajuste)' : 'Quantidade'}</Label>
            <Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" />
          </div>
          <div className="space-y-1.5">
            <Label>Custo Unitário (R$) — opcional</Label>
            <Input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder={String(material.unit_cost ?? '')} />
            <p className="text-xs text-gray-400">Se informado, atualiza o custo unitário do material.</p>
          </div>
          <div className="space-y-1.5"><Label>Observações</Label><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={save} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Registrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MovementsDialog({ target, onClose }: any) {
  const isAll = target === 'all';
  const { data, isLoading } = useQuery({
    queryKey: isAll ? ['/api/industria/movements'] : ['/api/industria/raw-materials', target.id, 'movements'],
    queryFn: () => jfetch(isAll ? '/api/industria/movements' : `/api/industria/raw-materials/${target.id}/movements`),
  });
  const movements: any[] = data?.movements || [];
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Histórico de Movimentações{isAll ? '' : ` — ${target.name}`}</DialogTitle></DialogHeader>
        <div className="border rounded-lg overflow-auto max-h-[65vh]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                {isAll && <TableHead>Material</TableHead>}
                <TableHead>Tipo</TableHead>
                <TableHead className="text-right">Qtd</TableHead>
                <TableHead className="text-right">Anterior</TableHead>
                <TableHead className="text-right">Novo</TableHead>
                <TableHead>Origem/Obs.</TableHead>
                <TableHead>Usuário</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {movements.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="whitespace-nowrap">{fmtDateTime(m.created_at)}</TableCell>
                  {isAll && <TableCell>{m.material_name || '-'}</TableCell>}
                  <TableCell>
                    <Badge variant="outline" className={MOV_IN_SET.has(m.movement_type) ? 'text-emerald-600' : m.movement_type === 'ajuste' ? 'text-blue-600' : 'text-red-600'}>
                      {MOV_LABEL[m.movement_type] || m.movement_type}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">{fmtQty(m.quantity)}</TableCell>
                  <TableCell className="text-right">{fmtQty(m.previous_quantity)}</TableCell>
                  <TableCell className="text-right font-medium">{fmtQty(m.new_quantity)}</TableCell>
                  <TableCell className="max-w-[260px] truncate" title={m.notes || ''}>{m.order_number ? `${m.order_number}` : ''}{m.order_number && m.notes ? ' · ' : ''}{m.notes || '-'}</TableCell>
                  <TableCell className="text-xs">{m.created_by || '-'}</TableCell>
                </TableRow>
              ))}
              {!isLoading && movements.length === 0 && (
                <TableRow><TableCell colSpan={isAll ? 8 : 7} className="text-center text-gray-400 py-8">Nenhuma movimentação registrada</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
const MOV_IN_SET = new Set(['entrada', 'entrada_compra', 'devolucao']);

// ===========================================================================
// ABA 3 — ORDENS DE PRODUÇÃO
// ===========================================================================
function OrdensTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('todos');
  const [orderDialog, setOrderDialog] = useState<any>(null);     // {} novo, order p/ editar
  const [finalizeDialog, setFinalizeDialog] = useState<any>(null);
  const [detailsDialog, setDetailsDialog] = useState<any>(null);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['/api/industria/production-orders'],
    queryFn: () => jfetch('/api/industria/production-orders'),
  });
  const orders: any[] = data?.orders || [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['/api/industria/production-orders'] });
    qc.invalidateQueries({ queryKey: ['/api/industria/raw-materials'] });
    qc.invalidateQueries({ queryKey: ['/api/inventory/summary'] });
  };

  const counts = useMemo(() => ({
    planejada: orders.filter((o) => o.status === 'planejada').length,
    em_producao: orders.filter((o) => o.status === 'em_producao').length,
    finalizada: orders.filter((o) => o.status === 'finalizada').length,
    produzido: orders.filter((o) => o.status === 'finalizada').reduce((s, o) => s + n(o.quantity), 0),
  }), [orders]);

  const filtered = useMemo(() => {
    let list = orders;
    if (statusFilter !== 'todos') list = list.filter((o) => o.status === statusFilter);
    if (search.trim()) {
      const s = search.toLowerCase();
      list = list.filter((o) => [o.order_number, o.product_name].some((v) => String(v ?? '').toLowerCase().includes(s)));
    }
    return list;
  }, [orders, search, statusFilter]);

  const startOrder = async (o: any) => {
    try {
      await jfetch(`/api/industria/production-orders/${o.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'em_producao' }) });
      toast({ title: 'Produção iniciada', description: o.order_number });
      invalidate();
    } catch (e: any) { toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' }); }
  };

  const removeOrder = async (o: any) => {
    if (!window.confirm(`Excluir a ordem ${o.order_number} (${o.product_name})?`)) return;
    try {
      await jfetch(`/api/industria/production-orders/${o.id}`, { method: 'DELETE' });
      toast({ title: 'Ordem excluída', description: o.order_number });
      invalidate();
    } catch (e: any) { toast({ title: 'Erro ao excluir', description: String(e.message || e), variant: 'destructive' }); }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-blue-100 rounded-lg"><ClipboardList className="h-5 w-5 text-blue-600" /></div>
          <div><p className="text-2xl font-bold">{counts.planejada}</p><p className="text-xs text-gray-500">Planejadas</p></div>
        </CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-yellow-100 rounded-lg"><Loader2 className="h-5 w-5 text-yellow-600" /></div>
          <div><p className="text-2xl font-bold">{counts.em_producao}</p><p className="text-xs text-gray-500">Em Produção</p></div>
        </CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-green-100 rounded-lg"><CheckCircle2 className="h-5 w-5 text-green-600" /></div>
          <div><p className="text-2xl font-bold">{counts.finalizada}</p><p className="text-xs text-gray-500">Finalizadas</p></div>
        </CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-emerald-100 rounded-lg"><Package className="h-5 w-5 text-emerald-600" /></div>
          <div><p className="text-2xl font-bold">{fmtQty(counts.produzido)}</p><p className="text-xs text-gray-500">Unidades Produzidas</p></div>
        </CardContent></Card>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
          <Input placeholder="Buscar ordem ou produto..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 w-[260px]" />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos os status</SelectItem>
            {Object.entries(ORDER_STATUS).map(([v, s]) => <SelectItem key={v} value={v}>{s.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
        <span className="text-sm text-gray-500">{isLoading ? 'Carregando...' : `${filtered.length} de ${orders.length} ordens`}</span>
        <div className="flex-1" />
        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => setOrderDialog({})}>
          <Plus className="h-4 w-4 mr-1" /> Nova Ordem
        </Button>
      </div>

      <div className="border rounded-lg overflow-auto max-h-[60vh]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ordem</TableHead>
              <TableHead>Produto</TableHead>
              <TableHead className="text-right">Qtd</TableHead>
              <TableHead>Instância</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Insumos</TableHead>
              <TableHead>Data Produção</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((o) => {
              const st = ORDER_STATUS[o.status] || { label: o.status, cls: '' };
              return (
                <TableRow key={o.id} className="cursor-pointer hover:bg-gray-50" onClick={() => setDetailsDialog(o)}>
                  <TableCell className="font-mono text-xs">{o.order_number}</TableCell>
                  <TableCell className="font-medium">{o.product_name}</TableCell>
                  <TableCell className="text-right">{fmtQty(o.quantity)}</TableCell>
                  <TableCell>{o.instance_name || '-'}</TableCell>
                  <TableCell><Badge className={st.cls}>{st.label}</Badge></TableCell>
                  <TableCell>{(o.items || []).length} material(is)</TableCell>
                  <TableCell>{fmtDate(o.production_date || o.created_at)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    {o.status === 'planejada' && (
                      <Button variant="ghost" size="sm" title="Iniciar produção" onClick={() => startOrder(o)}>
                        <PlayCircle className="h-4 w-4 text-yellow-600" />
                      </Button>
                    )}
                    {(o.status === 'planejada' || o.status === 'em_producao') && (
                      <>
                        <Button variant="ghost" size="sm" title="Finalizar ordem" onClick={() => setFinalizeDialog(o)}>
                          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                        </Button>
                        <Button variant="ghost" size="sm" title="Editar" onClick={() => setOrderDialog(o)}>
                          <Pencil className="h-4 w-4 text-blue-500" />
                        </Button>
                        <Button variant="ghost" size="sm" title="Excluir" className="text-red-500 hover:text-red-600" onClick={() => removeOrder(o)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {!isLoading && filtered.length === 0 && (
              <TableRow><TableCell colSpan={8} className="text-center text-gray-400 py-8">Nenhuma ordem de produção</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {orderDialog != null && <OrderDialog order={orderDialog} onClose={() => setOrderDialog(null)} onDone={() => { setOrderDialog(null); invalidate(); }} />}
      {finalizeDialog && <FinalizeDialog order={finalizeDialog} onClose={() => setFinalizeDialog(null)} onDone={() => { setFinalizeDialog(null); invalidate(); }} />}
      {detailsDialog && <OrderDetailsDialog order={detailsDialog} onClose={() => setDetailsDialog(null)} />}
    </div>
  );
}

function useIndustriaAux() {
  const { data: rm } = useQuery({ queryKey: ['/api/industria/raw-materials'], queryFn: () => jfetch('/api/industria/raw-materials') });
  const { data: rec } = useQuery({ queryKey: ['/api/industria/recipes'], queryFn: () => jfetch('/api/industria/recipes') });
  const { data: prods } = useQuery({
    queryKey: ['/api/products', 'industria'],
    queryFn: async () => { const r = await fetch('/api/products', { credentials: 'include' }); return r.ok ? r.json() : []; },
  });
  const materials: any[] = (rm?.materials || []).slice().sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
  const recipes: any[] = (rec?.recipes || []).filter((r: any) => r.is_active !== false);
  const products: any[] = (Array.isArray(prods) ? prods : []).slice().sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
  return { materials, recipes, products };
}

function OrderDialog({ order, onClose, onDone }: any) {
  const { toast } = useToast();
  const { materials, recipes, products } = useIndustriaAux();
  const isNew = !order.id;
  const [recipeId, setRecipeId] = useState('');
  const [f, setF] = useState<any>({
    product_id: order.product_id || '', product_name: order.product_name || '',
    quantity: order.quantity != null ? String(order.quantity) : '1',
    instance_name: order.instance_name || 'IND',
    status: order.status || 'planejada',
    production_date: order.production_date ? String(order.production_date).slice(0, 10) : new Date().toISOString().slice(0, 10),
    notes: order.notes || '',
    items: (order.items || []).map((it: any) => ({ raw_material_id: it.raw_material_id, quantity_used: String(it.quantity_used ?? ''), unit: it.unit || '' })),
  });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const [saving, setSaving] = useState(false);

  const applyRecipe = (rid: string, qtyStr?: string) => {
    const r = recipes.find((x) => String(x.id) === rid);
    if (!r) return;
    const mult = Math.max(n(qtyStr ?? f.quantity) || 1, 0);
    setF((p: any) => ({
      ...p,
      product_id: r.product_id || '',
      product_name: r.product_name || r.name,
      items: (r.items || []).map((it: any) => ({
        raw_material_id: it.raw_material_id,
        quantity_used: String(+(n(it.quantity) * mult).toFixed(4)),
        unit: it.unit || '',
      })),
    }));
  };

  const onQtyChange = (v: string) => { set('quantity', v); if (recipeId) applyRecipe(recipeId, v); };

  const setItem = (idx: number, patch: any) => setF((p: any) => {
    const items = p.items.slice(); items[idx] = { ...items[idx], ...patch }; return { ...p, items };
  });
  const addItem = () => setF((p: any) => ({ ...p, items: [...p.items, { raw_material_id: '', quantity_used: '', unit: '' }] }));
  const rmItem = (idx: number) => setF((p: any) => ({ ...p, items: p.items.filter((_: any, i: number) => i !== idx) }));

  const save = async () => {
    if (!String(f.product_name || '').trim()) { toast({ title: 'Informe o produto', variant: 'destructive' }); return; }
    if (!(n(f.quantity) > 0)) { toast({ title: 'Quantidade inválida', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      const body = { ...f, items: f.items.filter((it: any) => it.raw_material_id && n(it.quantity_used) > 0) };
      if (isNew) {
        const j = await jfetch('/api/industria/production-orders', { method: 'POST', body: JSON.stringify(body) });
        toast({ title: 'Ordem criada', description: j.order?.order_number });
      } else {
        await jfetch(`/api/industria/production-orders/${order.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast({ title: 'Ordem atualizada', description: order.order_number });
      }
      onDone();
    } catch (e: any) { toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' }); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{isNew ? 'Nova Ordem de Produção' : `Editar Ordem ${order.order_number}`}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 space-y-1.5">
            <Label className="text-emerald-700 flex items-center gap-1"><FileText className="h-4 w-4" /> Usar Receita</Label>
            <Select value={recipeId} onValueChange={(v) => { setRecipeId(v); applyRecipe(v); }}>
              <SelectTrigger className="bg-white"><SelectValue placeholder="Selecionar receita..." /></SelectTrigger>
              <SelectContent>
                {recipes.map((r) => <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-emerald-700">A receita preenche produto e ingredientes automaticamente. Quantidades são multiplicadas pela quantidade da ordem.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Produto *</Label>
              <Input list="ind-produtos" value={f.product_name}
                onChange={(e) => {
                  const v = e.target.value;
                  const p = products.find((x) => x.name === v);
                  const m = materials.find((x) => x.name === v);
                  setF((prev: any) => ({ ...prev, product_name: v, product_id: p ? String(p.id) : m ? String(m.id) : prev.product_id }));
                }}
                placeholder="Buscar produto ou matéria-prima..." />
              <datalist id="ind-produtos">
                {products.map((p) => <option key={p.id} value={p.name} />)}
                {materials.map((m) => <option key={m.id} value={m.name} />)}
              </datalist>
              <p className="text-xs text-gray-400">Produtos (sucos) geram lote de produto acabado; matéria-prima (ex.: polpa) entra no estoque de MP.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>Quantidade *</Label><Input inputMode="decimal" value={f.quantity} onChange={(e) => onQtyChange(e.target.value)} /></div>
              <div className="space-y-1.5"><Label>Instância</Label><Input value={f.instance_name} onChange={(e) => set('instance_name', e.target.value)} /></div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={f.status} onValueChange={(v) => set('status', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="planejada">Planejada</SelectItem>
                  <SelectItem value="em_producao">Em Produção</SelectItem>
                  {!isNew && <SelectItem value="cancelada">Cancelada</SelectItem>}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5"><Label>Data da Produção *</Label><Input type="date" value={f.production_date} onChange={(e) => set('production_date', e.target.value)} /></div>
          </div>

          <div className="space-y-1.5"><Label>Observações</Label><Textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold">Matéria-Prima Utilizada</Label>
              <Button type="button" variant="outline" size="sm" onClick={addItem}><Plus className="h-4 w-4 mr-1" /> Adicionar Material</Button>
            </div>
            {f.items.length === 0 && <p className="text-sm text-gray-400">Nenhum material adicionado. Use uma receita ou adicione manualmente.</p>}
            {f.items.map((it: any, idx: number) => {
              const mat = materials.find((m) => String(m.id) === String(it.raw_material_id));
              const enough = mat ? n(mat.quantity) >= n(it.quantity_used) : true;
              return (
                <div key={idx} className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <Select value={it.raw_material_id ? String(it.raw_material_id) : ''} onValueChange={(v) => {
                      const m = materials.find((x) => String(x.id) === v);
                      setItem(idx, { raw_material_id: v, unit: it.unit || m?.unit || '' });
                    }}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Selecionar..." /></SelectTrigger>
                      <SelectContent>
                        {it.raw_material_id && !materials.some((m) => String(m.id) === String(it.raw_material_id)) && (
                          <SelectItem value={String(it.raw_material_id)}>{it.raw_material_id}</SelectItem>
                        )}
                        {materials.map((m) => <SelectItem key={m.id} value={String(m.id)}>{m.name}{m.unit ? ` (${m.unit})` : ''}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <Input className="w-24 h-8 text-xs" inputMode="decimal" placeholder="Qtd Total" value={it.quantity_used} onChange={(e) => setItem(idx, { quantity_used: e.target.value })} />
                  {mat && (
                    <span className={`text-xs whitespace-nowrap ${enough ? 'text-emerald-600' : 'text-red-600'}`}>
                      (estoque: {fmtQty(mat.quantity)})
                    </span>
                  )}
                  <Button type="button" variant="ghost" size="sm" className="text-red-500" onClick={() => rmItem(idx)}><X className="h-4 w-4" /></Button>
                </div>
              );
            })}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={save} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}{isNew ? 'Criar Ordem' : 'Salvar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FinalizeDialog({ order, onClose, onDone }: any) {
  const { toast } = useToast();
  const { materials } = useIndustriaAux();
  const [f, setF] = useState<any>({
    quantity_produced: String(order.quantity ?? ''),
    lot_number: '', lot_expiry_date: '',
    production_date: order.production_date ? String(order.production_date).slice(0, 10) : new Date().toISOString().slice(0, 10),
    brix_degree: '', ph: '', sensory_analysis: '',
    pasteurization_start_time: '', pasteurization_end_time: '',
    pasteurization_start_temp: '', pasteurization_end_temp: '',
    notes: '',
    materials: (order.items || []).map((it: any) => ({
      raw_material_id: it.raw_material_id, quantity_used: String(it.quantity_used ?? ''), lot_number: it.lot_number || '', unit: it.unit || '',
    })),
  });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const setMat = (idx: number, patch: any) => setF((p: any) => {
    const ms = p.materials.slice(); ms[idx] = { ...ms[idx], ...patch }; return { ...p, materials: ms };
  });
  const addMat = () => setF((p: any) => ({ ...p, materials: [...p.materials, { raw_material_id: '', quantity_used: '', lot_number: '', unit: '' }] }));
  const rmMat = (idx: number) => setF((p: any) => ({ ...p, materials: p.materials.filter((_: any, i: number) => i !== idx) }));
  const [saving, setSaving] = useState(false);

  const cmv = useMemo(() => {
    const total = f.materials.reduce((s: number, m: any) => {
      const mat = materials.find((x) => String(x.id) === String(m.raw_material_id));
      return s + n(m.quantity_used) * n(mat?.unit_cost);
    }, 0);
    const qty = n(f.quantity_produced);
    return { total, unit: qty > 0 ? total / qty : 0 };
  }, [f.materials, f.quantity_produced, materials]);

  const save = async () => {
    if (!(n(f.quantity_produced) > 0)) { toast({ title: 'Quantidade produzida inválida', variant: 'destructive' }); return; }
    if (!String(f.lot_number).trim()) { toast({ title: 'Número do lote do produto acabado é obrigatório', variant: 'destructive' }); return; }
    if (!f.lot_expiry_date) { toast({ title: 'Validade do lote produzido é obrigatória', variant: 'destructive' }); return; }
    if (f.brix_degree !== '' && !(n(f.brix_degree) > 0)) { toast({ title: 'Grau Brix inválido', variant: 'destructive' }); return; }
    if (f.ph !== '' && !(n(f.ph) > 0)) { toast({ title: 'PH inválido', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      const j = await jfetch(`/api/industria/production-orders/${order.id}/finalize`, {
        method: 'POST',
        body: JSON.stringify({ ...f, materials: f.materials.filter((m: any) => m.raw_material_id && n(m.quantity_used) > 0) }),
      });
      toast({ title: `Ordem ${order.order_number} finalizada`, description: `CMV ${fmtBRL(j.cmv?.total)} (unit. ${fmtBRL(j.cmv?.unit)})` });
      (j.warnings || []).forEach((w: string) => toast({ title: 'Atenção', description: w, variant: 'destructive' }));
      onDone();
    } catch (e: any) { toast({ title: 'Erro ao finalizar', description: String(e.message || e), variant: 'destructive' }); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Finalizar Ordem {order.order_number}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-gray-500">{order.product_name} · Quantidade planejada: <b>{fmtQty(order.quantity)}</b></p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1.5"><Label>Quantidade Produzida (real) *</Label><Input inputMode="decimal" value={f.quantity_produced} onChange={(e) => set('quantity_produced', e.target.value)} /></div>
            <div className="space-y-1.5">
              <Label>Número do Lote *</Label>
              <Input value={f.lot_number} onChange={(e) => set('lot_number', e.target.value)} placeholder="Ex: LOTE-2026-001" />
            </div>
            <div className="space-y-1.5"><Label>Validade do Lote *</Label><Input type="date" value={f.lot_expiry_date} onChange={(e) => set('lot_expiry_date', e.target.value)} /></div>
          </div>
          <p className="text-xs text-gray-400 -mt-1">O lote será atribuído ao estoque do produto acabado (ou ao estoque de matéria-prima, no caso de polpa).</p>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold">Matéria-Prima Consumida (real)</Label>
              <Button type="button" variant="outline" size="sm" onClick={addMat}><Plus className="h-4 w-4 mr-1" /> Adicionar</Button>
            </div>
            {f.materials.map((m: any, idx: number) => {
              const mat = materials.find((x) => String(x.id) === String(m.raw_material_id));
              const enough = mat ? n(mat.quantity) >= n(m.quantity_used) : true;
              const sub = n(m.quantity_used) * n(mat?.unit_cost);
              return (
                <div key={idx} className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <Select value={m.raw_material_id ? String(m.raw_material_id) : ''} onValueChange={(v) => setMat(idx, { raw_material_id: v })}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Material..." /></SelectTrigger>
                      <SelectContent>
                        {m.raw_material_id && !materials.some((x) => String(x.id) === String(m.raw_material_id)) && (
                          <SelectItem value={String(m.raw_material_id)}>{m.raw_material_id}</SelectItem>
                        )}
                        {materials.map((x) => <SelectItem key={x.id} value={String(x.id)}>{x.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <Input className="w-20 h-8 text-xs" inputMode="decimal" placeholder="Qtd Real" value={m.quantity_used} onChange={(e) => setMat(idx, { quantity_used: e.target.value })} />
                  <Input className="w-28 h-8 text-xs" placeholder="Lote insumo" value={m.lot_number} onChange={(e) => setMat(idx, { lot_number: e.target.value })} />
                  <span className={`text-[10px] whitespace-nowrap ${enough ? 'text-emerald-600' : 'text-red-600'}`}>est: {mat ? fmtQty(mat.quantity) : '?'}</span>
                  <span className="text-[10px] text-gray-500 whitespace-nowrap w-16 text-right">{fmtBRL(sub)}</span>
                  <Button type="button" variant="ghost" size="sm" className="text-red-500" onClick={() => rmMat(idx)}><X className="h-4 w-4" /></Button>
                </div>
              );
            })}
          </div>

          <div className="rounded-lg border p-3 space-y-3">
            <Label className="text-sm font-semibold flex items-center gap-1"><FlaskConical className="h-4 w-4" /> Análise do Produto Acabado</Label>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5"><Label className="text-xs">Grau Brix</Label><Input inputMode="decimal" value={f.brix_degree} onChange={(e) => set('brix_degree', e.target.value)} placeholder="Ex: 12.5" /></div>
              <div className="space-y-1.5"><Label className="text-xs">pH</Label><Input inputMode="decimal" value={f.ph} onChange={(e) => set('ph', e.target.value)} placeholder="Ex: 3.8" /></div>
              <div className="space-y-1.5">
                <Label className="text-xs">Análise Sensorial</Label>
                <Select value={f.sensory_analysis} onValueChange={(v) => set('sensory_analysis', v)}>
                  <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="conforme">Conforme</SelectItem>
                    <SelectItem value="nao_conforme">Não Conforme</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div className="space-y-1.5"><Label className="text-xs">Início Pasteurização</Label><Input type="time" value={f.pasteurization_start_time} onChange={(e) => set('pasteurization_start_time', e.target.value)} /></div>
              <div className="space-y-1.5"><Label className="text-xs">Fim Pasteurização</Label><Input type="time" value={f.pasteurization_end_time} onChange={(e) => set('pasteurization_end_time', e.target.value)} /></div>
              <div className="space-y-1.5"><Label className="text-xs">Temp. Mín. (°C)</Label><Input inputMode="decimal" value={f.pasteurization_start_temp} onChange={(e) => set('pasteurization_start_temp', e.target.value)} placeholder="85.0" /></div>
              <div className="space-y-1.5"><Label className="text-xs">Temp. Máx. (°C)</Label><Input inputMode="decimal" value={f.pasteurization_end_temp} onChange={(e) => set('pasteurization_end_temp', e.target.value)} placeholder="90.0" /></div>
            </div>
          </div>

          <div className="rounded-lg bg-gray-50 dark:bg-gray-800 p-3">
            <p className="text-sm font-semibold mb-1">CMV — Custo de Mercadoria Vendida</p>
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div><p className="text-xs text-gray-500">Custo Total MP</p><p className="font-bold">{fmtBRL(cmv.total)}</p></div>
              <div><p className="text-xs text-gray-500">Qtd Produzida</p><p className="font-bold">{fmtQty(f.quantity_produced)}</p></div>
              <div><p className="text-xs text-gray-500">CMV Unitário</p><p className="font-bold">{fmtBRL(cmv.unit)}</p></div>
            </div>
          </div>

          <div className="space-y-1.5"><Label>Observações</Label><Textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={save} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Concluir Finalização
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OrderDetailsDialog({ order, onClose }: any) {
  const st = ORDER_STATUS[order.status] || { label: order.status, cls: '' };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{order.order_number} — {order.product_name}</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className={st.cls}>{st.label}</Badge>
            <span>Qtd: <b>{fmtQty(order.quantity)}</b></span>
            <span>Instância: <b>{order.instance_name || '-'}</b></span>
            <span>Produção: <b>{fmtDate(order.production_date)}</b></span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs text-gray-600">
            <span>Início: {fmtDateTime(order.start_date)}</span>
            <span>Fim: {fmtDateTime(order.end_date)}</span>
            <span>Criada por: {order.created_by || '-'}</span>
            <span>Validade lote: {fmtDate(order.lot_expiry_date)}</span>
          </div>
          {(order.brix_degree != null || order.ph != null || order.sensory_analysis) && (
            <div className="rounded-lg border p-2 text-xs">
              <p className="font-semibold mb-1">Análise do Produto Acabado</p>
              <p>Brix: {order.brix_degree ?? '-'} · pH: {order.ph ?? '-'} · Sensorial: {order.sensory_analysis === 'nao_conforme' ? 'Não Conforme' : order.sensory_analysis === 'conforme' ? 'Conforme' : '-'}</p>
              {(order.pasteurization_start_time || order.pasteurization_end_time) && (
                <p>Pasteurização: {order.pasteurization_start_time || '-'} → {order.pasteurization_end_time || '-'} ({order.pasteurization_start_temp ?? '-'}°C a {order.pasteurization_end_temp ?? '-'}°C)</p>
              )}
            </div>
          )}
          <div>
            <p className="font-semibold mb-1">Insumos</p>
            <Table>
              <TableHeader><TableRow><TableHead>Material</TableHead><TableHead className="text-right">Qtd</TableHead><TableHead>Un.</TableHead><TableHead>Lote</TableHead></TableRow></TableHeader>
              <TableBody>
                {(order.items || []).map((it: any) => (
                  <TableRow key={it.id}>
                    <TableCell>{it.raw_material_name}</TableCell>
                    <TableCell className="text-right">{fmtQty(it.quantity_used)}</TableCell>
                    <TableCell>{it.unit || '-'}</TableCell>
                    <TableCell>{it.lot_number || '-'}</TableCell>
                  </TableRow>
                ))}
                {(order.items || []).length === 0 && <TableRow><TableCell colSpan={4} className="text-center text-gray-400">Sem insumos</TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
          {order.notes && <p className="text-xs text-gray-500 whitespace-pre-wrap">{order.notes}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ===========================================================================
// ABA 4 — ESTOQUE PRODUTO ACABADO (lotes — mesmo sistema consumido pela NF-e)
// ===========================================================================
function EstoqueTab() {
  const [search, setSearch] = useState('');
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['/api/inventory/summary'],
    queryFn: () => jfetch('/api/inventory/summary'),
  });
  const lots: any[] = data?.lots || [];
  const negativos = lots.filter((l) => n(l.quantity) < 0).length;

  const filtered = useMemo(() => {
    if (!search.trim()) return lots;
    const s = search.toLowerCase();
    return lots.filter((l) => [l.product?.name, l.lotNumber].some((v) => String(v ?? '').toLowerCase().includes(s)));
  }, [lots, search]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-emerald-100 rounded-lg"><Package className="h-5 w-5 text-emerald-600" /></div>
          <div><p className="text-2xl font-bold">{data?.totalProducts ?? 0}</p><p className="text-xs text-gray-500">Produtos</p></div>
        </CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-green-100 rounded-lg"><CheckCircle2 className="h-5 w-5 text-green-600" /></div>
          <div><p className="text-2xl font-bold">{fmtQty(data?.totalInUse ?? 0)}</p><p className="text-xs text-gray-500">Em Uso</p></div>
        </CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-orange-100 rounded-lg"><Package className="h-5 w-5 text-orange-600" /></div>
          <div><p className="text-2xl font-bold">{fmtQty(data?.totalBlocked ?? 0)}</p><p className="text-xs text-gray-500">Bloqueado</p></div>
        </CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-red-100 rounded-lg"><AlertTriangle className="h-5 w-5 text-red-600" /></div>
          <div><p className="text-2xl font-bold">{negativos}</p><p className="text-xs text-gray-500">Estoque Negativo</p></div>
        </CardContent></Card>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
          <Input placeholder="Buscar produto ou lote..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 w-[260px]" />
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
        <span className="text-sm text-gray-500">{isLoading ? 'Carregando...' : `${filtered.length} lote(s)`}</span>
        <div className="flex-1" />
        <Link href="/estoque">
          <Button variant="outline" size="sm"><ExternalLink className="h-4 w-4 mr-1" /> Gestão completa de Estoque</Button>
        </Link>
      </div>

      <div className="border rounded-lg overflow-auto max-h-[60vh]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Produto</TableHead>
              <TableHead>Lote</TableHead>
              <TableHead>Instância</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Quantidade</TableHead>
              <TableHead className="text-right">Mínimo</TableHead>
              <TableHead>Obs.</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="font-medium">{l.product?.name || l.productId}</TableCell>
                <TableCell className="font-mono text-xs">{l.lotNumber}</TableCell>
                <TableCell>{l.instance?.name || '-'}</TableCell>
                <TableCell>
                  {l.stockType === 'in_use'
                    ? <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">Em Uso</Badge>
                    : <Badge className="bg-orange-100 text-orange-700 hover:bg-orange-100">Bloqueado</Badge>}
                </TableCell>
                <TableCell className={`text-right ${n(l.quantity) < 0 ? 'text-red-600 font-semibold' : ''}`}>{fmtQty(l.quantity)}</TableCell>
                <TableCell className="text-right">{fmtQty(l.minQuantity)}</TableCell>
                <TableCell className="max-w-[220px] truncate text-xs" title={l.notes || ''}>{l.notes || '-'}</TableCell>
              </TableRow>
            ))}
            {!isLoading && filtered.length === 0 && (
              <TableRow><TableCell colSpan={7} className="text-center text-gray-400 py-8">Nenhum lote encontrado — finalize uma ordem de produção para gerar o primeiro lote</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ===========================================================================
// PÁGINA
// ===========================================================================
export default function Industry() {
  const [activeTab, setActiveTab] = useState('materia');
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="p-4 md:p-6">
        <div className="flex items-center gap-3 mb-6">
          <BackToDashboardButton />
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-100 rounded-lg"><Factory className="h-6 w-6 text-emerald-700" /></div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Indústria</h1>
              <p className="text-sm text-gray-500">Gestão industrial, matéria-prima e produção</p>
            </div>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-4 bg-white dark:bg-gray-800 border shadow-sm">
            <TabsTrigger value="materia" className="flex items-center gap-1.5 data-[state=active]:bg-emerald-50 data-[state=active]:text-emerald-700">
              <Package className="h-4 w-4" /> Matéria-Prima
            </TabsTrigger>
            <TabsTrigger value="receitas" className="flex items-center gap-1.5 data-[state=active]:bg-emerald-50 data-[state=active]:text-emerald-700">
              <FileText className="h-4 w-4" /> Receitas
            </TabsTrigger>
            <TabsTrigger value="ordens" className="flex items-center gap-1.5 data-[state=active]:bg-emerald-50 data-[state=active]:text-emerald-700">
              <ClipboardList className="h-4 w-4" /> Ordens de Produção
            </TabsTrigger>
            <TabsTrigger value="estoque" className="flex items-center gap-1.5 data-[state=active]:bg-emerald-50 data-[state=active]:text-emerald-700">
              <Factory className="h-4 w-4" /> Estoque Produto Acabado
            </TabsTrigger>
          </TabsList>

          <TabsContent value="materia"><MateriaPrimaTab /></TabsContent>
          <TabsContent value="receitas"><RecipesEditor /></TabsContent>
          <TabsContent value="ordens"><OrdensTab /></TabsContent>
          <TabsContent value="estoque"><EstoqueTab /></TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
