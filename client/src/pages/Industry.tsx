// ============================================================================
// MÓDULO INDÚSTRIA 2.0 — formato 1.0 completo + melhorias (18/ago/2026)
// Abas: Matéria-Prima · Receitas · Ordens de Produção · Estoque Produto Acabado · Documentos (05/set/2026)
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
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { exportToExcel } from '@/lib/tableTools';
import RecipesEditor from '@/components/RecipesEditor';
import DocumentosEmpresa from '@/components/DocumentosEmpresa';
import BackToDashboardButton from '@/components/BackToDashboardButton';
import {
  Factory, ClipboardList, FileText, History, Search, Plus, Package,
  CheckCircle2, AlertTriangle, Loader2, Pencil, Trash2, X, RefreshCw,
  ArrowDownCircle, PlayCircle, ExternalLink, FlaskConical, Printer, FileSpreadsheet, RotateCcw,
  Paperclip, Upload, Download, Eye,
  Truck, DollarSign,
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
// BUG DE FUSO (Flavio 29/ago): production_date e lot_expiry_date sao colunas
// DATE e chegam como 'YYYY-MM-DD'. new Date('2026-08-29') e lido pelo JS como
// meia-noite UTC = 28/08 21h em Brasilia (UTC-3) -> a tela mostrava um dia A
// MENOS que o banco (lista dizia 28/08 e o modal de edicao, que corta a string,
// dizia 29/08; "Validade lote 27/12" x "validade 2026-12-28" do rodape do CMV).
// Data pura e' dia de calendario, nao instante: formata sem passar por fuso.
// Mesma regra de instante usada em fmtDateTime, declarada aqui porque fmtDate
// tambem recebe created_at (datetime sem fuso) como fallback de production_date.
const asInstantFallback = (v: any) => {
  const s = String(v).trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) return new Date(s);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(:\d{2})?)(\.\d+)?$/);
  return m ? new Date(`${m[1]}T${m[2]}${m[4] || ''}Z`) : new Date(s);
};
const fmtDate = (v: any) => {
  if (!v) return '-';
  const s = String(v);
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) return `${ymd[3]}/${ymd[2]}/${ymd[1]}`;
  const d = asInstantFallback(s);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
};
// INSTANTE (start_date/end_date/created_at das OPs e movimentacoes): o banco grava com
// now() do Postgres, que roda em UTC, e a coluna nao carrega fuso ("2026-08-31 16:14:44").
// new Date() lia essa string como hora LOCAL e a tela mostrava 16:14 para uma OP finalizada
// as 13:14 de Brasilia -- 3h adiantada (Flavio, 31/ago). Aqui a string sem fuso e tratada
// como UTC (sufixo Z) e formatada em America/Sao_Paulo, a hora oficial do Brasil.
const asInstant = (v: any) => {
  const s = String(v).trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) return new Date(s);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(:\d{2})?)(\.\d+)?$/);
  return m ? new Date(`${m[1]}T${m[2]}${m[4] || ''}Z`) : new Date(s);
};
const BR_TZ = { timeZone: 'America/Sao_Paulo' } as const;
const fmtDateTime = (v: any) => {
  if (!v) return '-';
  const d = asInstant(v);
  return isNaN(d.getTime())
    ? String(v)
    : d.toLocaleDateString('pt-BR', BR_TZ) + ' ' + d.toLocaleTimeString('pt-BR', { ...BR_TZ, hour: '2-digit', minute: '2-digit' });
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

  // Metadado dos anexos de especificacao tecnica (so a contagem por material —
  // o binario nunca vem na listagem, senao a aba carregaria dezenas de MB).
  const { data: anexos } = useQuery<Record<string, { total: number }>>({
    queryKey: ['/api/industria/raw-materials/attachments/summary'],
    queryFn: () => jfetch('/api/industria/raw-materials/attachments/summary'),
  });

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
      // NAO chamar de 'value': o spread ...c traz value = a chave da categoria
      // ('polpa', 'fruta', ...), que e o que o onClick manda para o filtro. Se o
      // total em R$ sobrescrever essa chave, o card filtra por um numero e a
      // lista volta vazia.
      totalValue: list.reduce((s, m) => s + n(m.quantity) * n(m.unit_cost), 0),
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
      {/* Grid só renderiza com dados + key de remontagem — evita cards órfãos da
          fase de loading (18/ago: DOM ficou com 14 filhos enquanto o React tinha 8) */}
      {isLoading ? (
        <div className="text-sm text-gray-400 py-2">Carregando categorias...</div>
      ) : (
        <div key={`mp-cards-${materials.length}`} className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
          {cards.map((c) => (
            <Card key={c.value}
              className={`cursor-pointer ${catFilter === c.value ? 'ring-2 ring-emerald-500' : ''}`}
              onClick={() => setCatFilter(catFilter === c.value ? null : c.value)}>
              <CardContent className="p-3 text-center">
                <p className="text-xs text-gray-500">{c.label}</p>
                <p className="text-xl font-bold">{c.count}</p>
                <p className="text-[10px] text-gray-400">{fmtQty(c.qty)} un · {fmtBRL(c.totalValue)}</p>
                {c.low > 0 && <Badge className="mt-1 bg-red-500 text-white hover:bg-red-500 text-[10px]">{c.low} baixo</Badge>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

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
                    {n(anexos?.[m.id]?.total) > 0 && (
                      <Badge variant="outline" className="ml-1 text-[10px] gap-0.5" title="Especificacoes tecnicas anexadas">
                        <Paperclip className="h-2.5 w-2.5" />{anexos![m.id].total}
                      </Badge>
                    )}
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
          <AnexosEspecificacao materialId={f.id} />
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

// ---------------------------------------------------------------------------
// ANEXOS DE ESPECIFICACAO TECNICA (laudos, fichas do fornecedor, certificados)
// Varios arquivos por materia-prima, qualquer tipo, ate 15MB cada.
// Backend: /api/industria/raw-materials/:id/attachments (raw-material-attachments-routes.ts).
// Fica dentro do modal de edicao; no cadastro NOVO o material ainda nao tem id,
// entao a secao so avisa que os anexos entram depois de salvar.
// ---------------------------------------------------------------------------
const fmtBytes = (b: number) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

function AnexosEspecificacao({ materialId }: { materialId: string | null }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [enviando, setEnviando] = useState(false);
  const inputId = `mp-anexo-${materialId || 'novo'}`;

  const { data: lista, refetch } = useQuery<any[]>({
    queryKey: ['/api/industria/raw-materials', materialId, 'attachments'],
    queryFn: () => jfetch(`/api/industria/raw-materials/${materialId}/attachments`),
    enabled: !!materialId,
  });

  const atualizar = () => {
    refetch();
    qc.invalidateQueries({ queryKey: ['/api/industria/raw-materials/attachments/summary'] });
  };

  const enviar = async (files: FileList | null) => {
    if (!files?.length || !materialId) return;
    const grande = Array.from(files).find((f) => f.size > 15 * 1024 * 1024);
    if (grande) {
      toast({ title: 'Arquivo muito grande', description: `${grande.name} passa de 15MB.`, variant: 'destructive' });
      return;
    }
    setEnviando(true);
    try {
      const fd = new FormData();
      Array.from(files).forEach((f) => fd.append('arquivos', f));
      const r = await fetch(`/api/industria/raw-materials/${materialId}/attachments`, {
        method: 'POST', credentials: 'include', body: fd,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message || `Falha (${r.status})`);
      toast({ title: 'Especificação anexada', description: `${files.length} arquivo(s) enviado(s).` });
      atualizar();
    } catch (e: any) {
      toast({ title: 'Erro ao anexar', description: String(e.message || e), variant: 'destructive' });
    } finally { setEnviando(false); }
  };

  const remover = async (a: any) => {
    if (!confirm(`Remover o anexo "${a.fileName}"?`)) return;
    try {
      await jfetch(`/api/industria/raw-material-attachments/${a.id}`, { method: 'DELETE' });
      toast({ title: 'Anexo removido' });
      atualizar();
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-1.5"><Paperclip className="h-4 w-4" /> Especificações técnicas</Label>
        {materialId && (
          <>
            <input id={inputId} type="file" multiple className="hidden"
              onChange={(e) => { enviar(e.target.files); e.currentTarget.value = ''; }} />
            <label htmlFor={inputId}>
              <Button type="button" variant="outline" size="sm" asChild disabled={enviando}>
                <span className="cursor-pointer">
                  {enviando ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Upload className="h-4 w-4 mr-1" />}
                  Anexar arquivos
                </span>
              </Button>
            </label>
          </>
        )}
      </div>

      {!materialId ? (
        <p className="text-xs text-gray-400">Cadastre o material primeiro; depois reabra em Editar para anexar laudos, fichas do fornecedor e certificados.</p>
      ) : !lista?.length ? (
        <p className="text-xs text-gray-400">Nenhum arquivo anexado. Aceita PDF, imagem, Word, Excel e texto — até 15MB por arquivo.</p>
      ) : (
        <div className="divide-y">
          {lista.map((a: any) => (
            <div key={a.id} className="flex items-center gap-2 py-1.5">
              <FileText className="h-4 w-4 text-gray-400 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate" title={a.fileName}>{a.fileName}</p>
                <p className="text-[11px] text-gray-400">
                  {fmtBytes(a.fileSize)} · {fmtDate(a.createdAt)}
                  {a.extractStatus === 'sem_texto' && ' · sem texto pesquisável (PDF escaneado)'}
                </p>
              </div>
              <Button type="button" variant="ghost" size="sm" title="Abrir" asChild>
                <a href={`/api/industria/raw-material-attachments/${a.id}`} target="_blank" rel="noreferrer"><Eye className="h-4 w-4" /></a>
              </Button>
              <Button type="button" variant="ghost" size="sm" title="Baixar" asChild>
                <a href={`/api/industria/raw-material-attachments/${a.id}?download=1`}><Download className="h-4 w-4" /></a>
              </Button>
              <Button type="button" variant="ghost" size="sm" title="Remover" className="text-red-500 hover:text-red-600" onClick={() => remover(a)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
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
  // Seleção de ordens p/ relatório de matérias-primas (requisição de MP)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reportOpen, setReportOpen] = useState(false);
  const [opReportOpen, setOpReportOpen] = useState(false);

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

  // Reabrir ordem finalizada (Flavio 29/ago): o servidor ESTORNA o estoque da
  // finalização antes de destravar — MP consumida volta, lote acabado é baixado.
  const reopenOrder = async (o: any) => {
    if (!window.confirm(
      `Reabrir a ordem ${o.order_number} (${o.product_name})?\n\n` +
      `O estoque da finalização será ESTORNADO: a matéria-prima consumida volta ao estoque e o lote de produto acabado gerado é baixado. ` +
      `A ordem volta para "Em Produção" e precisará ser finalizada de novo.`
    )) return;
    try {
      const j = await jfetch(`/api/industria/production-orders/${o.id}/reopen`, { method: 'POST' });
      toast({
        title: `Ordem ${o.order_number} reaberta`,
        description: (j.estorno || []).length ? `Estorno: ${(j.estorno || []).join(', ')}` : 'Sem movimentos de estoque a estornar',
      });
      for (const w of (j.warnings || [])) toast({ title: 'Atenção', description: String(w), variant: 'destructive' });
      invalidate();
    } catch (e: any) { toast({ title: 'Erro ao reabrir', description: String(e.message || e), variant: 'destructive' }); }
  };

  const removeOrder = async (o: any) => {
    const fin = o.status === 'finalizada';
    if (!window.confirm(
      `Excluir a ordem ${o.order_number} (${o.product_name})?` +
      (fin ? `\n\nEsta ordem está FINALIZADA: o estoque da finalização será estornado antes da exclusão (MP consumida volta, lote acabado é baixado). As movimentações ficam no histórico. Não dá para desfazer.` : '')
    )) return;
    try {
      const j = await jfetch(`/api/industria/production-orders/${o.id}`, { method: 'DELETE' });
      toast({
        title: 'Ordem excluída',
        description: o.order_number + ((j?.estorno?.undone || []).length ? ` — estorno: ${j.estorno.undone.join(', ')}` : ''),
      });
      for (const w of (j?.warnings || [])) toast({ title: 'Atenção', description: String(w), variant: 'destructive' });
      invalidate();
    } catch (e: any) { toast({ title: 'Erro ao excluir', description: String(e.message || e), variant: 'destructive' }); }
  };

  return (
    <div className="space-y-4">
      <div key={`op-cards-${orders.length}`} className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
        <Button variant="outline" size="sm" disabled={selected.size === 0} onClick={() => setReportOpen(true)}
          title="Relatório agregado das matérias-primas das ordens selecionadas">
          <Printer className="h-4 w-4 mr-1" /> Relatório de MP ({selected.size})
        </Button>
        <Button variant="outline" size="sm" disabled={selected.size === 0} onClick={() => setOpReportOpen(true)}
          title="Relatório produtivo completo das ordens selecionadas">
          <ClipboardList className="h-4 w-4 mr-1" /> Relatório de OP ({selected.size})
        </Button>
        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => setOrderDialog({})}>
          <Plus className="h-4 w-4 mr-1" /> Nova Ordem
        </Button>
      </div>

      <div className="border rounded-lg overflow-auto max-h-[60vh]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  checked={filtered.length > 0 && filtered.every((o) => selected.has(o.id))}
                  onCheckedChange={(v) => {
                    setSelected((prev) => {
                      const nx = new Set(prev);
                      if (v) filtered.forEach((o) => nx.add(o.id));
                      else filtered.forEach((o) => nx.delete(o.id));
                      return nx;
                    });
                  }}
                  title="Selecionar todas as ordens filtradas"
                />
              </TableHead>
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
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selected.has(o.id)}
                      onCheckedChange={(v) => {
                        setSelected((prev) => {
                          const nx = new Set(prev);
                          if (v) nx.add(o.id); else nx.delete(o.id);
                          return nx;
                        });
                      }}
                    />
                  </TableCell>
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
                    {o.status === 'finalizada' && (
                      <>
                        <Button variant="ghost" size="sm" title="Reabrir ordem (estorna o estoque da finalização)" onClick={() => reopenOrder(o)}>
                          <RotateCcw className="h-4 w-4 text-amber-600" />
                        </Button>
                        <Button variant="ghost" size="sm" title="Excluir (estorna o estoque da finalização)" className="text-red-500 hover:text-red-600" onClick={() => removeOrder(o)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {!isLoading && filtered.length === 0 && (
              <TableRow><TableCell colSpan={9} className="text-center text-gray-400 py-8">Nenhuma ordem de produção</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {orderDialog != null && <OrderDialog order={orderDialog} onClose={() => setOrderDialog(null)} onDone={() => { setOrderDialog(null); invalidate(); }} />}
      {finalizeDialog && <FinalizeDialog order={finalizeDialog} onClose={() => setFinalizeDialog(null)} onDone={() => { setFinalizeDialog(null); invalidate(); }} />}
      {detailsDialog && <OrderDetailsDialog order={detailsDialog} onClose={() => setDetailsDialog(null)} />}
      {reportOpen && (
        <MateriaisReportDialog
          orders={orders.filter((o) => selected.has(o.id))}
          onClose={() => setReportOpen(false)}
        />
      )}
      {opReportOpen && (
        <OrdensReportDialog
          orders={orders.filter((o) => selected.has(o.id))}
          onClose={() => setOpReportOpen(false)}
        />
      )}
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
    items: (order.items || []).map((it: any) => ({ raw_material_id: it.raw_material_id, quantity_used: String(it.quantity_used ?? ''), unit: it.unit || '', lot_number: it.lot_number || '' })),
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
      items: (r.items || []).map((it: any) => {
        // preserva lote já digitado p/ o mesmo material ao reaplicar a receita
        const prev = p.items.find((x: any) => String(x.raw_material_id) === String(it.raw_material_id));
        return {
          raw_material_id: it.raw_material_id,
          quantity_used: String(+(n(it.quantity) * mult).toFixed(4)),
          unit: it.unit || '',
          lot_number: prev?.lot_number || '',
        };
      }),
    }));
  };

  const onQtyChange = (v: string) => { set('quantity', v); if (recipeId) applyRecipe(recipeId, v); };

  const setItem = (idx: number, patch: any) => setF((p: any) => {
    const items = p.items.slice(); items[idx] = { ...items[idx], ...patch }; return { ...p, items };
  });
  const addItem = () => setF((p: any) => ({ ...p, items: [...p.items, { raw_material_id: '', quantity_used: '', unit: '', lot_number: '' }] }));
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
                  <Input className="w-28 h-8 text-xs" placeholder="Lote MP" title="Lote da matéria-prima" value={it.lot_number || ''} onChange={(e) => setItem(idx, { lot_number: e.target.value })} />
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
    // Ordem reaberta já traz lote/validade/qualidade da finalização anterior —
    // preenche para o operador só corrigir o que errou (Flavio 29/ago).
    lot_number: order.lot_number || '',
    lot_expiry_date: order.lot_expiry_date ? String(order.lot_expiry_date).slice(0, 10) : '',
    production_date: order.production_date ? String(order.production_date).slice(0, 10) : new Date().toISOString().slice(0, 10),
    brix_degree: order.brix_degree != null ? String(order.brix_degree) : '',
    ph: order.ph != null ? String(order.ph) : '',
    sensory_analysis: order.sensory_analysis || '',
    pasteurization_start_time: order.pasteurization_start_time || '',
    pasteurization_end_time: order.pasteurization_end_time || '',
    pasteurization_start_temp: order.pasteurization_start_temp != null ? String(order.pasteurization_start_temp) : '',
    pasteurization_end_temp: order.pasteurization_end_temp != null ? String(order.pasteurization_end_temp) : '',
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
// RELATÓRIO DE MATÉRIAS-PRIMAS — requisição de MP das ordens selecionadas
// Agrega quantity_used por material, cruza com estoque atual e custo, e emite
// versão impressa (com assinaturas p/ o chão de fábrica) e Excel.
// ===========================================================================
const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]));

function MateriaisReportDialog({ orders, onClose }: any) {
  const { materials } = useIndustriaAux();

  const rows = useMemo(() => {
    const agg = new Map<string, any>();
    for (const o of orders) {
      for (const it of (o.items || [])) {
        const k = String(it.raw_material_id || it.raw_material_name || '');
        const cur = agg.get(k) || { id: it.raw_material_id, name: it.raw_material_name || '?', unit: it.unit || '', total: 0, ords: new Set<string>() };
        cur.total += n(it.quantity_used);
        if (it.raw_material_name) cur.name = it.raw_material_name;
        if (it.unit) cur.unit = it.unit;
        cur.ords.add(o.order_number);
        if (it.lot_number) (cur.lots = cur.lots || new Set<string>()).add(String(it.lot_number));
        agg.set(k, cur);
      }
    }
    return Array.from(agg.values()).map((r: any) => {
      const mat = materials.find((m: any) => String(m.id) === String(r.id));
      const stock = mat ? n(mat.quantity) : null;
      const cost = mat ? n(mat.unit_cost) : 0;
      return {
        ...r,
        name: mat?.name || r.name,
        unit: mat?.unit || r.unit,
        stock,
        saldo: stock == null ? null : stock - r.total,
        cost,
        totalCost: r.total * cost,
        ordersList: Array.from(r.ords).sort().join(', '),
        lotsList: r.lots ? Array.from(r.lots).sort().join(', ') : '',
      };
    }).sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
  }, [orders, materials]);

  const custoTotal = rows.reduce((s: number, r: any) => s + r.totalCost, 0);
  const faltando = rows.filter((r: any) => r.saldo != null && r.saldo < 0);

  const doExcel = () => {
    exportToExcel(rows.map((r: any) => ({
      'Material': r.name,
      'Unidade': r.unit,
      'Necessário': +r.total.toFixed(3),
      'Estoque Atual': r.stock == null ? '' : +r.stock.toFixed(3),
      'Saldo Após Produção': r.saldo == null ? '' : +r.saldo.toFixed(3),
      'Custo Unit. (R$)': +r.cost.toFixed(4),
      'Custo Total (R$)': +r.totalCost.toFixed(2),
      'Lotes MP': r.lotsList,
      'Ordens': r.ordersList,
    })), `requisicao-mp-${new Date().toISOString().slice(0, 10)}`);
  };

  const doPrint = () => {
    const hoje = new Date().toLocaleDateString('pt-BR') + ' ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Requisição de Matéria-Prima</title>
<style>body{font-family:Arial,sans-serif;margin:24px;color:#111}h1{font-size:18px;margin:0}h2{font-size:12px;color:#555;font-weight:normal;margin:2px 0 0}
.cab{display:flex;align-items:center;gap:16px;border-bottom:2px solid #16a34a;padding-bottom:10px;margin-bottom:10px}.cab img{height:58px}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}th,td{border:1px solid #bbb;padding:5px 7px;text-align:left}th{background:#f0f0f0}
td.num,th.num{text-align:right}tr.neg td{color:#b00020;font-weight:bold}tfoot td{font-weight:bold;background:#fafafa}
.ordens{font-size:12px;margin:6px 0 2px}.aviso{color:#b00020;font-size:12px}
.assin{margin-top:42px;display:flex;gap:40px;font-size:12px}.assin div{flex:1;border-top:1px solid #333;padding-top:4px;text-align:center}</style></head><body>
<div class="cab"><img src="${window.location.origin}/honest-logo.png" alt="Honest"><div>
<h1>Requisição de Matéria-Prima — Produção</h1>
<h2>Sistema Integra · Honest Sucos · emitido em ${hoje}</h2>
</div></div>
<div class="ordens"><b>Ordens selecionadas (${orders.length}):</b><br>${orders.map((o: any) => `${o.order_number} — ${esc(o.product_name)} (${fmtQty(o.quantity)} un, ${fmtDate(o.production_date || o.created_at)})`).join('<br>')}</div>
<table><thead><tr><th>Material</th><th>Un.</th><th class="num">Necessário</th><th class="num">Estoque Atual</th><th class="num">Saldo Após</th><th class="num">Custo Unit.</th><th class="num">Custo Total</th><th>Lote MP</th><th>Ordens</th></tr></thead>
<tbody>${rows.map((r: any) => `<tr${r.saldo != null && r.saldo < 0 ? ' class="neg"' : ''}><td>${esc(r.name)}</td><td>${esc(r.unit || '')}</td><td class="num">${fmtQty(r.total)}</td><td class="num">${r.stock == null ? '-' : fmtQty(r.stock)}</td><td class="num">${r.saldo == null ? '-' : fmtQty(r.saldo)}</td><td class="num">${fmtBRL(r.cost)}</td><td class="num">${fmtBRL(r.totalCost)}</td><td>${esc(r.lotsList || '')}</td><td>${esc(r.ordersList)}</td></tr>`).join('')}</tbody>
<tfoot><tr><td colspan="6">Custo total estimado das matérias-primas</td><td class="num">${fmtBRL(custoTotal)}</td><td colspan="2"></td></tr></tfoot></table>
${faltando.length ? `<p class="aviso"><b>Atenção:</b> ${faltando.length} material(is) com estoque insuficiente: ${faltando.map((r: any) => esc(r.name)).join(', ')}.</p>` : ''}
<div class="assin"><div>Separado por</div><div>Conferido por</div><div>Data / Hora</div></div>
<script>window.onload=function(){window.print()}</script></body></html>`;
    const w = window.open('', '_blank');
    if (!w) { alert('Libere pop-ups para imprimir o relatório.'); return; }
    w.document.write(html);
    w.document.close();
    w.focus();
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Requisição de Matéria-Prima — {orders.length} ordem(ns)</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-gray-500">
            {orders.map((o: any) => `${o.order_number} (${o.product_name} × ${fmtQty(o.quantity)})`).join(' · ')}
          </p>
          <div className="border rounded-lg overflow-auto max-h-[55vh]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Material</TableHead>
                  <TableHead>Un.</TableHead>
                  <TableHead className="text-right">Necessário</TableHead>
                  <TableHead className="text-right">Estoque Atual</TableHead>
                  <TableHead className="text-right">Saldo Após</TableHead>
                  <TableHead className="text-right">Custo Total</TableHead>
                  <TableHead>Lote MP</TableHead>
                  <TableHead>Ordens</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r: any) => (
                  <TableRow key={String(r.id || r.name)}>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell>{r.unit || '-'}</TableCell>
                    <TableCell className="text-right font-semibold">{fmtQty(r.total)}</TableCell>
                    <TableCell className="text-right">{r.stock == null ? '-' : fmtQty(r.stock)}</TableCell>
                    <TableCell className={`text-right ${r.saldo != null && r.saldo < 0 ? 'text-red-600 font-bold' : 'text-emerald-600'}`}>
                      {r.saldo == null ? '-' : fmtQty(r.saldo)}
                    </TableCell>
                    <TableCell className="text-right">{fmtBRL(r.totalCost)}</TableCell>
                    <TableCell className="text-xs">{r.lotsList || '-'}</TableCell>
                    <TableCell className="text-xs text-gray-500">{r.ordersList}</TableCell>
                  </TableRow>
                ))}
                {rows.length === 0 && (
                  <TableRow><TableCell colSpan={8} className="text-center text-gray-400 py-6">As ordens selecionadas não têm insumos cadastrados</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-sm">Custo total estimado: <b>{fmtBRL(custoTotal)}</b></p>
            {faltando.length > 0 && (
              <p className="text-sm text-red-600 flex items-center gap-1">
                <AlertTriangle className="h-4 w-4" /> {faltando.length} material(is) com estoque insuficiente
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Fechar</Button>
          <Button variant="outline" onClick={doExcel}><FileSpreadsheet className="h-4 w-4 mr-1" /> Excel</Button>
          <Button onClick={doPrint} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            <Printer className="h-4 w-4 mr-1" /> Imprimir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ===========================================================================
// RELATÓRIO DE OP — relatório produtivo completo das ordens selecionadas
// Traz ficha de produção de cada OP (dados, análise, pasteurização, insumos
// com lote e custo, CMV) + consolidado. Versão impressa e Excel.
// ===========================================================================
function OrdensReportDialog({ orders, onClose }: any) {
  const { materials } = useIndustriaAux();

  const data = useMemo(() => {
    const list = orders.map((o: any) => {
      const items = (o.items || []).map((it: any) => {
        const mat = materials.find((m: any) => String(m.id) === String(it.raw_material_id));
        const qty = n(it.quantity_used);
        const cost = mat ? n(mat.unit_cost) : 0;
        return {
          name: mat?.name || it.raw_material_name || '?',
          unit: it.unit || mat?.unit || '',
          qty,
          lot: it.lot_number || '',
          cost,
          total: qty * cost,
        };
      }).sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
      const cmvTotal = items.reduce((s: number, i: any) => s + i.total, 0);
      const planejada = n(o.quantity);
      const produzida = o.quantity_produced != null ? n(o.quantity_produced) : (o.status === 'finalizada' ? planejada : 0);
      const base = produzida > 0 ? produzida : planejada;
      return {
        o,
        items,
        cmvTotal,
        cmvUnit: base > 0 ? cmvTotal / base : 0,
        planejada,
        produzida,
        rendimento: planejada > 0 && produzida > 0 ? (produzida / planejada) * 100 : null,
      };
    });
    const tot = {
      ordens: list.length,
      planejada: list.reduce((s: number, r: any) => s + r.planejada, 0),
      produzida: list.reduce((s: number, r: any) => s + r.produzida, 0),
      cmv: list.reduce((s: number, r: any) => s + r.cmvTotal, 0),
      finalizadas: list.filter((r: any) => r.o.status === 'finalizada').length,
      emProducao: list.filter((r: any) => r.o.status === 'em_producao').length,
      planejadas: list.filter((r: any) => r.o.status === 'planejada').length,
    };
    return { list, tot };
  }, [orders, materials]);

  const stLabel = (s: string) => (ORDER_STATUS[s]?.label || s || '-');
  const sensLabel = (s: any) => (s === 'nao_conforme' ? 'Não Conforme' : s === 'conforme' ? 'Conforme' : '-');

  const doExcel = () => {
    const rows: any[] = [];
    for (const r of data.list) {
      const o = r.o;
      const baseCols = {
        'Ordem': o.order_number,
        'Produto': o.product_name,
        'Status': stLabel(o.status),
        'Instância': o.instance_name || '',
        'Data Produção': fmtDate(o.production_date || o.created_at),
        'Início': fmtDateTime(o.start_date),
        'Fim': fmtDateTime(o.end_date),
        'Criada por': o.created_by || '',
        'Qtd Planejada': +r.planejada.toFixed(3),
        'Qtd Produzida': +r.produzida.toFixed(3),
        'Rendimento (%)': r.rendimento == null ? '' : +r.rendimento.toFixed(1),
        'Lote Produzido': o.lot_number || '',
        'Validade Lote': fmtDate(o.lot_expiry_date),
        'Brix': o.brix_degree ?? '',
        'pH': o.ph ?? '',
        'Sensorial': sensLabel(o.sensory_analysis),
        'Pasteurização Início': o.pasteurization_start_time || '',
        'Pasteurização Fim': o.pasteurization_end_time || '',
        'Temp. Mín (°C)': o.pasteurization_start_temp ?? '',
        'Temp. Máx (°C)': o.pasteurization_end_temp ?? '',
        'CMV Total (R$)': +r.cmvTotal.toFixed(2),
        'CMV Unitário (R$)': +r.cmvUnit.toFixed(4),
        'Observações': o.notes || '',
      };
      if (r.items.length === 0) {
        rows.push({ ...baseCols, 'Material': '', 'Un.': '', 'Qtd Consumida': '', 'Lote MP': '', 'Custo Unit. (R$)': '', 'Custo Total (R$)': '' });
      } else {
        for (const it of r.items) {
          rows.push({
            ...baseCols,
            'Material': it.name,
            'Un.': it.unit,
            'Qtd Consumida': +it.qty.toFixed(3),
            'Lote MP': it.lot,
            'Custo Unit. (R$)': +it.cost.toFixed(4),
            'Custo Total (R$)': +it.total.toFixed(2),
          });
        }
      }
    }
    exportToExcel(rows, `relatorio-op-${new Date().toISOString().slice(0, 10)}`);
  };

  const doPrint = () => {
    const hoje = new Date().toLocaleDateString('pt-BR') + ' ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const fichas = data.list.map((r: any) => {
      const o = r.o;
      const analise = (o.brix_degree != null || o.ph != null || o.sensory_analysis || o.pasteurization_start_time || o.pasteurization_end_time)
        ? `<table class="kv"><tbody>
<tr><th>Grau Brix</th><td>${esc(o.brix_degree ?? '-')}</td><th>pH</th><td>${esc(o.ph ?? '-')}</td><th>Análise sensorial</th><td>${esc(sensLabel(o.sensory_analysis))}</td></tr>
<tr><th>Pasteurização</th><td colspan="5">${esc(o.pasteurization_start_time || '-')} → ${esc(o.pasteurization_end_time || '-')} · ${esc(o.pasteurization_start_temp ?? '-')}°C a ${esc(o.pasteurization_end_temp ?? '-')}°C</td></tr>
</tbody></table>`
        : '<p class="vazio">Sem dados de análise/pasteurização registrados.</p>';
      return `<div class="op">
<h3>${esc(o.order_number)} — ${esc(o.product_name)} <span class="badge">${esc(stLabel(o.status))}</span></h3>
<table class="kv"><tbody>
<tr><th>Instância</th><td>${esc(o.instance_name || '-')}</td><th>Data de produção</th><td>${fmtDate(o.production_date || o.created_at)}</td><th>Criada por</th><td>${esc(o.created_by || '-')}</td></tr>
<tr><th>Início</th><td>${fmtDateTime(o.start_date)}</td><th>Fim</th><td>${fmtDateTime(o.end_date)}</td><th>Lote produzido</th><td>${esc(o.lot_number || '-')} (val. ${fmtDate(o.lot_expiry_date)})</td></tr>
<tr><th>Qtd planejada</th><td>${fmtQty(r.planejada)}</td><th>Qtd produzida</th><td>${r.produzida ? fmtQty(r.produzida) : '-'}</td><th>Rendimento</th><td>${r.rendimento == null ? '-' : r.rendimento.toFixed(1) + '%'}</td></tr>
</tbody></table>
<p class="sec">Análise do produto acabado</p>
${analise}
<p class="sec">Matéria-prima consumida</p>
<table><thead><tr><th>Material</th><th>Un.</th><th class="num">Qtd</th><th>Lote MP</th><th class="num">Custo Unit.</th><th class="num">Custo Total</th></tr></thead>
<tbody>${r.items.length ? r.items.map((it: any) => `<tr><td>${esc(it.name)}</td><td>${esc(it.unit)}</td><td class="num">${fmtQty(it.qty)}</td><td>${esc(it.lot || '-')}</td><td class="num">${fmtBRL(it.cost)}</td><td class="num">${fmtBRL(it.total)}</td></tr>`).join('') : '<tr><td colspan="6">Sem insumos cadastrados</td></tr>'}</tbody>
<tfoot><tr><td colspan="5">CMV total da ordem (unitário ${fmtBRL(r.cmvUnit)})</td><td class="num">${fmtBRL(r.cmvTotal)}</td></tr></tfoot></table>
${o.notes ? `<p class="obs"><b>Observações:</b> ${esc(o.notes)}</p>` : ''}
</div>`;
    }).join('');

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Relatório de Produção</title>
<style>body{font-family:Arial,sans-serif;margin:24px;color:#111}h1{font-size:18px;margin:0}h2{font-size:12px;color:#555;font-weight:normal;margin:2px 0 0}
h3{font-size:14px;margin:0 0 6px}.cab{display:flex;align-items:center;gap:16px;border-bottom:2px solid #16a34a;padding-bottom:10px;margin-bottom:12px}.cab img{height:58px}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:4px}th,td{border:1px solid #bbb;padding:5px 7px;text-align:left}th{background:#f0f0f0}
td.num,th.num{text-align:right}tfoot td{font-weight:bold;background:#fafafa}
table.kv th{width:12%;background:#f7f7f7}table.kv td{width:21%}
.op{border:1px solid #ddd;border-radius:6px;padding:10px 12px;margin-bottom:14px;page-break-inside:avoid}
.badge{font-size:11px;font-weight:normal;border:1px solid #999;border-radius:10px;padding:1px 8px;margin-left:6px}
.sec{font-size:12px;font-weight:bold;margin:10px 0 2px}.vazio{font-size:12px;color:#777;margin:2px 0}
.obs{font-size:12px;margin-top:6px;white-space:pre-wrap}
.resumo td,.resumo th{font-size:12px}
.assin{margin-top:36px;display:flex;gap:40px;font-size:12px}.assin div{flex:1;border-top:1px solid #333;padding-top:4px;text-align:center}</style></head><body>
<div class="cab"><img src="${window.location.origin}/honest-logo.png" alt="Honest"><div>
<h1>Relatório de Produção — Ordens de Produção</h1>
<h2>Sistema Integra · Honest Sucos · emitido em ${hoje}</h2>
</div></div>
<table class="resumo"><thead><tr><th>Ordens</th><th>Planejadas</th><th>Em produção</th><th>Finalizadas</th><th class="num">Qtd planejada</th><th class="num">Qtd produzida</th><th class="num">CMV total</th></tr></thead>
<tbody><tr><td>${data.tot.ordens}</td><td>${data.tot.planejadas}</td><td>${data.tot.emProducao}</td><td>${data.tot.finalizadas}</td><td class="num">${fmtQty(data.tot.planejada)}</td><td class="num">${fmtQty(data.tot.produzida)}</td><td class="num">${fmtBRL(data.tot.cmv)}</td></tr></tbody></table>
${fichas}
<div class="assin"><div>Produção</div><div>Qualidade</div><div>Data / Hora</div></div>
<script>window.onload=function(){window.print()}</script></body></html>`;
    const w = window.open('', '_blank');
    if (!w) { alert('Libere pop-ups para imprimir o relatório.'); return; }
    w.document.write(html);
    w.document.close();
    w.focus();
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Relatório de Produção — {orders.length} ordem(ns)</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            <div className="rounded-lg border p-2"><p className="text-xs text-gray-500">Ordens</p><p className="font-bold">{data.tot.ordens}</p></div>
            <div className="rounded-lg border p-2"><p className="text-xs text-gray-500">Qtd planejada</p><p className="font-bold">{fmtQty(data.tot.planejada)}</p></div>
            <div className="rounded-lg border p-2"><p className="text-xs text-gray-500">Qtd produzida</p><p className="font-bold">{fmtQty(data.tot.produzida)}</p></div>
            <div className="rounded-lg border p-2"><p className="text-xs text-gray-500">CMV total</p><p className="font-bold">{fmtBRL(data.tot.cmv)}</p></div>
          </div>
          <div className="border rounded-lg overflow-auto max-h-[55vh]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ordem</TableHead>
                  <TableHead>Produto</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Planejada</TableHead>
                  <TableHead className="text-right">Produzida</TableHead>
                  <TableHead className="text-right">Rend.</TableHead>
                  <TableHead>Lote</TableHead>
                  <TableHead>Brix / pH</TableHead>
                  <TableHead className="text-right">CMV</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.list.map((r: any) => (
                  <TableRow key={r.o.id}>
                    <TableCell className="font-mono text-xs">{r.o.order_number}</TableCell>
                    <TableCell className="font-medium">{r.o.product_name}</TableCell>
                    <TableCell className="text-xs">{stLabel(r.o.status)}</TableCell>
                    <TableCell className="text-right">{fmtQty(r.planejada)}</TableCell>
                    <TableCell className="text-right">{r.produzida ? fmtQty(r.produzida) : '-'}</TableCell>
                    <TableCell className="text-right text-xs">{r.rendimento == null ? '-' : `${r.rendimento.toFixed(1)}%`}</TableCell>
                    <TableCell className="text-xs">{r.o.lot_number || '-'}</TableCell>
                    <TableCell className="text-xs">{(r.o.brix_degree ?? '-') + ' / ' + (r.o.ph ?? '-')}</TableCell>
                    <TableCell className="text-right">{fmtBRL(r.cmvTotal)}</TableCell>
                  </TableRow>
                ))}
                {data.list.length === 0 && (
                  <TableRow><TableCell colSpan={9} className="text-center text-gray-400 py-6">Nenhuma ordem selecionada</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-gray-500">
            A versão impressa traz a ficha completa de cada ordem: datas, responsável, lote e validade, análise (Brix, pH, sensorial),
            pasteurização, matéria-prima consumida com lote e custo, CMV total e unitário.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Fechar</Button>
          <Button variant="outline" onClick={doExcel}><FileSpreadsheet className="h-4 w-4 mr-1" /> Excel</Button>
          <Button onClick={doPrint} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            <Printer className="h-4 w-4 mr-1" /> Imprimir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ===========================================================================
// ABA 4 — ESTOQUE PRODUTO ACABADO (lotes — mesmo sistema consumido pela NF-e)
// ===========================================================================
function TransferenciaDialog({ lotes, onClose, onDone }: { lotes: any[]; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [enviando, setEnviando] = useState(false);
  const [destinoId, setDestinoId] = useState<string>('');
  const [customerId, setCustomerId] = useState<string>('');
  const [obs, setObs] = useState('');
  // Quantidade por lote: comeca no saldo inteiro, mas e editavel — transferir a
  // producao inteira e o caso comum, nao uma regra.
  const [qtds, setQtds] = useState<Record<string, string>>(
    () => Object.fromEntries(lotes.map((l) => [l.id, String(n(l.quantity))])));

  const { data: dest } = useQuery({
    queryKey: ['/api/inventory/transfer-order/destinations'],
    queryFn: () => jfetch('/api/inventory/transfer-order/destinations'),
  });
  const destinos: any[] = dest?.destinations || [];
  const destinoSel = destinos.find((d) => d.instanceId === destinoId) || null;

  // Pre-seleciona GYN se ele aparecer na lista — e o destino de 99% das transferencias.
  useMemo(() => {
    if (destinoId || !destinos.length) return;
    const gyn = destinos.find((d) => String(d.instanceName).toUpperCase() === 'GYN') || destinos[0];
    if (gyn) { setDestinoId(gyn.instanceId); setCustomerId(gyn.customerId || ''); }
  }, [destinos.length]);

  const linhas = lotes.map((l) => {
    const q = n(qtds[l.id]);
    const unit = l.cmvUnit != null ? Number(l.cmvUnit) : null;
    return { lot: l, q, unit, total: unit != null ? unit * q : null, saldo: n(l.quantity) };
  });
  const semCmv = linhas.filter((r) => r.unit == null);
  const excedidas = linhas.filter((r) => r.q > r.saldo || r.q <= 0);
  const total = linhas.reduce((sum, r) => sum + (r.total || 0), 0);
  const podeEnviar = !!destinoId && !!customerId && !semCmv.length && !excedidas.length && !enviando;

  const enviar = async () => {
    setEnviando(true);
    try {
      const j = await jfetch('/api/inventory/transfer-order', {
        method: 'POST',
        body: JSON.stringify({
          lots: linhas.map((r) => ({ lotId: r.lot.id, quantity: r.q })),
          destinationInstanceId: destinoId,
          customerId,
          notes: obs || undefined,
        }),
      });
      toast({
        title: `Pedido ${j.orderNumber} criado`,
        description: `${linhas.length} lote(s) · ${fmtBRL(j.total)} — está em "A Faturar" no pipeline de faturamento.`,
      });
      onDone();
    } catch (e: any) {
      toast({ title: 'Não foi possível criar o pedido', description: e.message, variant: 'destructive' });
    } finally { setEnviando(false); }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="h-5 w-5 text-emerald-600" /> Pedido de transferência entre filiais
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <Label>Filial de destino</Label>
              <Select value={destinoId} onValueChange={(v) => {
                setDestinoId(v);
                setCustomerId(destinos.find((d) => d.instanceId === v)?.customerId || '');
              }}>
                <SelectTrigger><SelectValue placeholder="Selecione a filial" /></SelectTrigger>
                <SelectContent>
                  {destinos.map((d) => (
                    <SelectItem key={d.instanceId} value={d.instanceId}>{d.instanceDisplayName || d.instanceName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Destinatário da NF</Label>
              {destinoSel?.customerId ? (
                <div className="text-sm border rounded-md px-3 py-2 bg-gray-50 dark:bg-gray-800">
                  <b>{destinoSel.customerName}</b>
                  <span className="text-gray-500"> · {destinoSel.customerDocument || 'sem documento'}</span>
                  {destinoSel.matchBy === 'nome' && (
                    <p className="text-[11px] text-amber-600 mt-0.5">
                      Encontrado pelo nome, não pelo CNPJ da filial — confira antes de faturar.
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-red-600 border border-red-200 rounded-md px-3 py-2">
                  Nenhum cliente cadastrado com o CNPJ desta filial. Cadastre a filial como
                  cliente antes de emitir a transferência.
                </p>
              )}
            </div>
          </div>

          <div className="border rounded-lg overflow-auto max-h-[45vh]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produto</TableHead>
                  <TableHead>Lote</TableHead>
                  <TableHead className="text-right">Saldo</TableHead>
                  <TableHead className="text-right w-[130px]">Qtd. transferir</TableHead>
                  <TableHead className="text-right">CMV unit.</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {linhas.map((r) => (
                  <TableRow key={r.lot.id}>
                    <TableCell className="font-medium text-sm">{r.lot.product?.name || r.lot.productId}</TableCell>
                    <TableCell className="font-mono text-xs">{r.lot.lotNumber}</TableCell>
                    <TableCell className="text-right text-sm">{fmtQty(r.saldo)}</TableCell>
                    <TableCell className="text-right">
                      <Input
                        className={`h-8 text-right ${r.q > r.saldo || r.q <= 0 ? 'border-red-500' : ''}`}
                        value={qtds[r.lot.id] ?? ''}
                        onChange={(e) => setQtds((p) => ({ ...p, [r.lot.id]: e.target.value }))}
                      />
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {r.unit != null ? fmtBRL(r.unit) : <span className="text-red-600">sem CMV</span>}
                    </TableCell>
                    <TableCell className="text-right text-sm font-medium">
                      {r.total != null ? fmtBRL(r.total) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div>
            <Label>Observação (opcional)</Label>
            <Textarea value={obs} onChange={(e) => setObs(e.target.value)} rows={2}
              placeholder="Ex.: remessa da produção da semana" />
          </div>

          {semCmv.length > 0 && (
            <p className="text-sm text-red-600 flex items-center gap-1">
              <AlertTriangle className="h-4 w-4" />
              {semCmv.length} lote(s) sem CMV — não dá para precificar a transferência. Remova-os da seleção.
            </p>
          )}
          {excedidas.length > 0 && (
            <p className="text-sm text-red-600 flex items-center gap-1">
              <AlertTriangle className="h-4 w-4" /> Quantidade inválida ou maior que o saldo em {excedidas.length} linha(s).
            </p>
          )}
          <p className="text-sm">
            Total do pedido (a CMV): <b className="text-emerald-700">{fmtBRL(total)}</b>
            <span className="text-gray-500"> — o estoque só é baixado no faturamento.</span>
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={enviar} disabled={!podeEnviar} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            {enviando ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Truck className="h-4 w-4 mr-1" />}
            Emitir pedido para faturamento
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EstoqueTab() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [transferindo, setTransferindo] = useState(false);
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

  // Só lote com saldo e com CMV pode virar transferência: sem saldo não há o que
  // mandar, sem CMV não há por quanto mandar.
  const transferivel = (l: any) => n(l.quantity) > 0 && l.cmvUnit != null;
  const selecionaveis = filtered.filter(transferivel);
  const selecionados = lots.filter((l) => sel.has(l.id));
  const todosMarcados = selecionaveis.length > 0 && selecionaveis.every((l) => sel.has(l.id));

  const toggle = (id: string) => setSel((p) => {
    const nx = new Set(p);
    nx.has(id) ? nx.delete(id) : nx.add(id);
    return nx;
  });
  const toggleTodos = () => setSel((p) => {
    const nx = new Set(p);
    if (todosMarcados) selecionaveis.forEach((l) => nx.delete(l.id));
    else selecionaveis.forEach((l) => nx.add(l.id));
    return nx;
  });

  return (
    <div className="space-y-4">
      <div key={`inv-cards-${lots.length}`} className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-emerald-100 rounded-lg"><Package className="h-5 w-5 text-emerald-600" /></div>
          <div><p className="text-2xl font-bold">{data?.totalProducts ?? 0}</p><p className="text-xs text-gray-500">Produtos</p></div>
        </CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-green-100 rounded-lg"><CheckCircle2 className="h-5 w-5 text-green-600" /></div>
          <div><p className="text-2xl font-bold">{fmtQty(data?.totalInUse ?? 0)}</p><p className="text-xs text-gray-500">Em Uso</p></div>
        </CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-blue-100 rounded-lg"><DollarSign className="h-5 w-5 text-blue-600" /></div>
          <div>
            <p className="text-2xl font-bold">{fmtBRL(data?.valorEmEstoque ?? 0)}</p>
            <p className="text-xs text-gray-500">
              Valor a CMV{data?.lotesSemCmv ? ` · ${data.lotesSemCmv} lote(s) sem custo` : ''}
            </p>
          </div>
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
        {sel.size > 0 && (
          <Button size="sm" onClick={() => setTransferindo(true)} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            <Truck className="h-4 w-4 mr-1" /> Pedido de transferência ({sel.size})
          </Button>
        )}
        <div className="flex-1" />
        <Link href="/estoque">
          <Button variant="outline" size="sm"><ExternalLink className="h-4 w-4 mr-1" /> Gestão completa de Estoque</Button>
        </Link>
      </div>

      <div className="border rounded-lg overflow-auto max-h-[60vh]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <Checkbox checked={todosMarcados} onCheckedChange={toggleTodos}
                  disabled={!selecionaveis.length} aria-label="Selecionar todos os lotes transferíveis" />
              </TableHead>
              <TableHead>Produto</TableHead>
              <TableHead>Lote</TableHead>
              <TableHead>Instância</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Quantidade</TableHead>
              <TableHead className="text-right">CMV unit.</TableHead>
              <TableHead className="text-right">CMV do saldo</TableHead>
              <TableHead className="text-right">Mínimo</TableHead>
              <TableHead>Obs.</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((l) => (
              <TableRow key={l.id} className={sel.has(l.id) ? 'bg-emerald-50/60 dark:bg-emerald-950/20' : ''}>
                <TableCell>
                  <Checkbox checked={sel.has(l.id)} onCheckedChange={() => toggle(l.id)}
                    disabled={!transferivel(l)}
                    aria-label={`Selecionar lote ${l.lotNumber}`} />
                </TableCell>
                <TableCell className="font-medium">{l.product?.name || l.productId}</TableCell>
                <TableCell className="font-mono text-xs">{l.lotNumber}</TableCell>
                <TableCell>{l.instance?.name || '-'}</TableCell>
                <TableCell>
                  {l.stockType === 'in_use'
                    ? <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">Em Uso</Badge>
                    : <Badge className="bg-orange-100 text-orange-700 hover:bg-orange-100">Bloqueado</Badge>}
                </TableCell>
                <TableCell className={`text-right ${n(l.quantity) < 0 ? 'text-red-600 font-semibold' : ''}`}>{fmtQty(l.quantity)}</TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {l.cmvUnit != null ? (
                    <>
                      {fmtBRL(l.cmvUnit)}
                      {l.productionOrderNumber && (
                        <span className="block text-[10px] text-gray-400 font-mono">{l.productionOrderNumber}</span>
                      )}
                    </>
                  ) : <span className="text-gray-400">—</span>}
                </TableCell>
                <TableCell className="text-right">
                  {l.cmvStock != null ? fmtBRL(l.cmvStock) : <span className="text-gray-400">—</span>}
                </TableCell>
                <TableCell className="text-right">{fmtQty(l.minQuantity)}</TableCell>
                <TableCell className="max-w-[220px] truncate text-xs" title={l.notes || ''}>{l.notes || '-'}</TableCell>
              </TableRow>
            ))}
            {!isLoading && filtered.length === 0 && (
              <TableRow><TableCell colSpan={10} className="text-center text-gray-400 py-8">Nenhum lote encontrado — finalize uma ordem de produção para gerar o primeiro lote</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {transferindo && (
        <TransferenciaDialog
          lotes={selecionados}
          onClose={() => setTransferindo(false)}
          onDone={() => {
            setTransferindo(false);
            setSel(new Set());
            qc.invalidateQueries({ queryKey: ['/api/inventory/summary'] });
            qc.invalidateQueries({ queryKey: ['/api/billing-pipeline'] });
          }}
        />
      )}
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
            <TabsTrigger value="documentos" className="flex items-center gap-1.5 data-[state=active]:bg-emerald-50 data-[state=active]:text-emerald-700">
              <Paperclip className="h-4 w-4" /> Documentos
            </TabsTrigger>
          </TabsList>

          <TabsContent value="materia"><MateriaPrimaTab /></TabsContent>
          <TabsContent value="receitas"><RecipesEditor /></TabsContent>
          <TabsContent value="ordens"><OrdensTab /></TabsContent>
          <TabsContent value="estoque"><EstoqueTab /></TabsContent>
          <TabsContent value="documentos"><DocumentosEmpresa /></TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
