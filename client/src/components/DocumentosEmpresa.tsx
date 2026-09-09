// ============================================================================
// DOCUMENTOS DA EMPRESA — aba "Documentos" do módulo Indústria (05/set/2026)
// Cadastro de documentos institucionais/regulatórios (alvará, licença, AVCB,
// contrato social, certificado, laudo…) com: nome · instância · vigência ·
// status · arquivo anexado (opcional, até 15MB) · observações.
// Backend: /api/industria/documentos (server/company-documents-routes.ts).
// ============================================================================
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { exportToExcel } from '@/lib/tableTools';
import {
  FileText, Search, Plus, RefreshCw, Pencil, Trash2, Eye, Download, Upload,
  Loader2, FileSpreadsheet, CheckCircle2, AlertTriangle, Clock, Paperclip, X, Files, Tags, Save,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const STATUS = [
  { value: 'vigente', label: 'Vigente' },
  { value: 'em_renovacao', label: 'Em renovação' },
  { value: 'vencido', label: 'Vencido' },
  { value: 'suspenso', label: 'Suspenso' },
];
const STATUS_LABEL: Record<string, string> = Object.fromEntries(STATUS.map((s) => [s.value, s.label]));
const STATUS_CLASS: Record<string, string> = {
  vigente: 'bg-green-100 text-green-700',
  em_renovacao: 'bg-amber-100 text-amber-700',
  vencido: 'bg-red-100 text-red-700',
  suspenso: 'bg-gray-200 text-gray-700',
};
// Cores das categorias (mesma paleta dos badges do sistema).
const CORES = ['emerald', 'blue', 'amber', 'violet', 'rose', 'cyan', 'orange', 'slate'];
const COR_CLASS: Record<string, string> = {
  emerald: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  blue: 'bg-blue-100 text-blue-700 border-blue-200',
  amber: 'bg-amber-100 text-amber-700 border-amber-200',
  violet: 'bg-violet-100 text-violet-700 border-violet-200',
  rose: 'bg-rose-100 text-rose-700 border-rose-200',
  cyan: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  orange: 'bg-orange-100 text-orange-700 border-orange-200',
  slate: 'bg-slate-100 text-slate-700 border-slate-200',
};
const corClass = (c?: string) => COR_CLASS[c || 'slate'] || COR_CLASS.slate;

const FALLBACK_INSTANCIAS = [
  { name: 'IND', displayName: 'Indústria' },
  { name: 'GYN', displayName: 'Goiânia' },
];

const fmtDate = (v: any) => {
  if (!v) return '-';
  const s = String(v).slice(0, 10);
  const [y, m, d] = s.split('-');
  return y && m && d ? `${d}/${m}/${y}` : s;
};
const fmtBytes = (b: number) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

const jfetch = async (url: string, opts: any = {}) => {
  const r = await fetch(url, { credentials: 'include', headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(j?.error || j?.message || `Falha (${r.status})`);
  return j;
};

function Vigencia({ doc }: { doc: any }) {
  const periodo = doc.validFrom || doc.validUntil
    ? `${fmtDate(doc.validFrom)} → ${fmtDate(doc.validUntil)}`
    : 'Sem vigência';
  let aviso: React.ReactNode = null;
  if (doc.situacao === 'vencido') {
    aviso = <span className="text-[11px] text-red-600 font-medium">vencido há {Math.abs(doc.diasRestantes)} dia(s)</span>;
  } else if (doc.situacao === 'a_vencer') {
    aviso = <span className="text-[11px] text-amber-600 font-medium">{doc.diasRestantes === 0 ? 'vence hoje' : `vence em ${doc.diasRestantes} dia(s)`}</span>;
  }
  return (
    <div className="flex flex-col">
      <span className={doc.situacao === 'vencido' ? 'text-red-600' : ''}>{periodo}</span>
      {aviso}
    </div>
  );
}

// ---------------------------------------------------------------------------
// dialog de categorias (cadastro livre — toda categoria de documento vem daqui)
// ---------------------------------------------------------------------------
function CategoriasDialog({ categorias, onClose, onDone }: { categorias: any[]; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [nova, setNova] = useState({ name: '', color: 'emerald', description: '' });
  const [editando, setEditando] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const criar = async () => {
    if (!nova.name.trim()) { toast({ title: 'Informe o nome da categoria', variant: 'destructive' }); return; }
    setBusy(true);
    try {
      await jfetch('/api/industria/documentos/categorias', { method: 'POST', body: JSON.stringify(nova) });
      toast({ title: 'Categoria cadastrada', description: nova.name });
      setNova({ name: '', color: 'emerald', description: '' });
      onDone();
    } catch (e: any) { toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' }); }
    finally { setBusy(false); }
  };

  const salvarEdicao = async () => {
    if (!editando?.name?.trim()) { toast({ title: 'Informe o nome da categoria', variant: 'destructive' }); return; }
    setBusy(true);
    try {
      await jfetch(`/api/industria/documentos/categorias/${editando.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: editando.name, color: editando.color, description: editando.description }),
      });
      toast({ title: 'Categoria atualizada' });
      setEditando(null);
      onDone();
    } catch (e: any) { toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' }); }
    finally { setBusy(false); }
  };

  const remover = async (c: any) => {
    if (c.totalDocumentos > 0) {
      toast({ title: 'Categoria em uso', description: `${c.totalDocumentos} documento(s) usam "${c.name}". Mova-os para outra categoria antes de excluir.`, variant: 'destructive' });
      return;
    }
    if (!confirm(`Excluir a categoria "${c.name}"?`)) return;
    try {
      await jfetch(`/api/industria/documentos/categorias/${c.id}`, { method: 'DELETE' });
      toast({ title: 'Categoria removida' });
      onDone();
    } catch (e: any) { toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' }); }
  };

  const SeletorCor = ({ value, onChange }: { value: string; onChange: (c: string) => void }) => (
    <div className="flex items-center gap-1">
      {CORES.map((c) => (
        <button key={c} type="button" onClick={() => onChange(c)} title={c}
          className={`h-6 w-6 rounded-full border-2 ${corClass(c)} ${value === c ? 'ring-2 ring-offset-1 ring-gray-400' : ''}`} />
      ))}
    </div>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Tags className="h-5 w-5" /> Categorias de documento</DialogTitle></DialogHeader>

        <div className="rounded-md border p-3 space-y-2">
          <Label className="text-xs text-gray-500">Nova categoria</Label>
          <div className="flex items-end gap-2 flex-wrap">
            <div className="flex-1 min-w-[180px] space-y-1">
              <Input placeholder="Ex.: Regulatório, Fiscal, Códigos de Barras…" value={nova.name}
                onChange={(e) => setNova((p) => ({ ...p, name: e.target.value }))} />
            </div>
            <div className="flex-1 min-w-[180px] space-y-1">
              <Input placeholder="Descrição (opcional)" value={nova.description}
                onChange={(e) => setNova((p) => ({ ...p, description: e.target.value }))} />
            </div>
            <SeletorCor value={nova.color} onChange={(c) => setNova((p) => ({ ...p, color: c }))} />
            <Button size="sm" onClick={criar} disabled={busy} className="bg-emerald-600 hover:bg-emerald-700 text-white">
              <Plus className="h-4 w-4 mr-1" /> Adicionar
            </Button>
          </div>
        </div>

        <div className="border rounded-lg overflow-auto max-h-[45vh]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Categoria</TableHead>
                <TableHead>Descrição</TableHead>
                <TableHead className="text-right w-[110px]">Documentos</TableHead>
                <TableHead className="w-[110px] text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!categorias.length ? (
                <TableRow><TableCell colSpan={4} className="text-center py-6 text-gray-400">Nenhuma categoria cadastrada.</TableCell></TableRow>
              ) : categorias.map((c) => editando?.id === c.id ? (
                <TableRow key={c.id} className="bg-emerald-50/40">
                  <TableCell><Input value={editando.name} onChange={(e) => setEditando((p: any) => ({ ...p, name: e.target.value }))} className="h-8" /></TableCell>
                  <TableCell><Input value={editando.description || ''} onChange={(e) => setEditando((p: any) => ({ ...p, description: e.target.value }))} className="h-8" /></TableCell>
                  <TableCell><SeletorCor value={editando.color} onChange={(cor) => setEditando((p: any) => ({ ...p, color: cor }))} /></TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={salvarEdicao} disabled={busy} title="Salvar"><Save className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditando(null)} title="Cancelar"><X className="h-4 w-4" /></Button>
                  </TableCell>
                </TableRow>
              ) : (
                <TableRow key={c.id}>
                  <TableCell><Badge variant="outline" className={corClass(c.color)}>{c.name}</Badge></TableCell>
                  <TableCell className="text-sm text-gray-500">{c.description || '-'}</TableCell>
                  <TableCell className="text-right text-sm">{c.totalDocumentos ?? 0}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => setEditando({ ...c })} title="Editar"><Pencil className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-600" onClick={() => remover(c)} title="Excluir"><Trash2 className="h-4 w-4" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <DialogFooter><Button variant="outline" onClick={onClose}>Fechar</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// dialog novo / editar
// ---------------------------------------------------------------------------
function DocumentoDialog({ doc, instancias, categorias, onGerenciarCategorias, onClose, onDone }: { doc: any; instancias: any[]; categorias: any[]; onGerenciarCategorias: () => void; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const isNew = !doc?.id;
  const [f, setF] = useState({
    name: doc?.name || '',
    instanceName: doc?.instanceName || (instancias[0]?.name ?? 'IND'),
    categoryId: doc?.categoryId || (categorias[0]?.id ?? ''),
    validFrom: doc?.validFrom || '',
    validUntil: doc?.validUntil || '',
    status: doc?.status || 'vigente',
    notes: doc?.notes || '',
  });
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [removerArquivo, setRemoverArquivo] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));
  const inputId = `doc-arquivo-${doc?.id || 'novo'}`;

  const escolherArquivo = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      toast({ title: 'Arquivo muito grande', description: `${file.name} passa de 15MB.`, variant: 'destructive' });
      return;
    }
    setArquivo(file);
    setRemoverArquivo(false);
  };

  const save = async () => {
    if (!f.name.trim()) { toast({ title: 'Informe o nome do documento', variant: 'destructive' }); return; }
    if (!f.instanceName.trim()) { toast({ title: 'Informe a instância', variant: 'destructive' }); return; }
    if (!f.categoryId) { toast({ title: 'Selecione a categoria do documento', variant: 'destructive' }); return; }
    if (f.validFrom && f.validUntil && f.validFrom > f.validUntil) {
      toast({ title: 'Vigência inválida', description: 'O início não pode ser depois do fim.', variant: 'destructive' }); return;
    }
    setSaving(true);
    try {
      const fd = new FormData();
      Object.entries(f).forEach(([k, v]) => fd.append(k, String(v ?? '')));
      if (arquivo) fd.append('arquivo', arquivo);
      if (!arquivo && removerArquivo) fd.append('removerArquivo', '1');
      if (isNew) await jfetch('/api/industria/documentos', { method: 'POST', body: fd });
      else await jfetch(`/api/industria/documentos/${doc.id}`, { method: 'PATCH', body: fd });
      toast({ title: isNew ? 'Documento cadastrado' : 'Documento atualizado' });
      onDone();
      onClose();
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' });
    } finally { setSaving(false); }
  };

  const arquivoAtual = !isNew && doc?.hasFile && !removerArquivo && !arquivo;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>{isNew ? 'Novo documento' : `Editar — ${doc.name}`}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Nome do documento *</Label>
            <Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Ex.: Alvará Sanitário, AVCB, Contrato Social, Certificado A1…" autoFocus />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Categoria *</Label>
              <Button type="button" variant="ghost" size="sm" className="h-6 text-xs text-emerald-600" onClick={onGerenciarCategorias}>
                <Tags className="h-3.5 w-3.5 mr-1" /> Gerenciar categorias
              </Button>
            </div>
            <Select value={f.categoryId} onValueChange={(v) => set('categoryId', v)}>
              <SelectTrigger><SelectValue placeholder={categorias.length ? 'Selecione a categoria' : 'Cadastre uma categoria primeiro'} /></SelectTrigger>
              <SelectContent>
                {categorias.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {!categorias.length && <p className="text-[11px] text-amber-600">Nenhuma categoria cadastrada — clique em "Gerenciar categorias".</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Instância *</Label>
              <Select value={f.instanceName} onValueChange={(v) => set('instanceName', v)}>
                <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>
                  {instancias.map((i) => (
                    <SelectItem key={i.name} value={i.name}>{i.name}{i.displayName && i.displayName !== i.name ? ` — ${i.displayName}` : ''}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Status *</Label>
              <Select value={f.status} onValueChange={(v) => set('status', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STATUS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Vigência — início</Label>
              <Input type="date" value={f.validFrom} onChange={(e) => set('validFrom', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Vigência — fim</Label>
              <Input type="date" value={f.validUntil} onChange={(e) => set('validUntil', e.target.value)} />
              <p className="text-[11px] text-gray-400">Deixe em branco se o documento não expira.</p>
            </div>
          </div>

          <div className="space-y-1.5 rounded-md border p-3">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-1.5"><Paperclip className="h-4 w-4" /> Arquivo</Label>
              <input id={inputId} type="file" className="hidden" onChange={(e) => { escolherArquivo(e.target.files); e.currentTarget.value = ''; }} />
              <label htmlFor={inputId}>
                <Button type="button" variant="outline" size="sm" asChild>
                  <span className="cursor-pointer"><Upload className="h-4 w-4 mr-1" /> {arquivoAtual || arquivo ? 'Trocar arquivo' : 'Anexar arquivo'}</span>
                </Button>
              </label>
            </div>
            {arquivo ? (
              <div className="flex items-center gap-2 text-sm">
                <FileText className="h-4 w-4 text-emerald-600 shrink-0" />
                <span className="truncate flex-1" title={arquivo.name}>{arquivo.name}</span>
                <span className="text-xs text-gray-400">{fmtBytes(arquivo.size)}</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => setArquivo(null)} title="Descartar"><X className="h-4 w-4" /></Button>
              </div>
            ) : arquivoAtual ? (
              <div className="flex items-center gap-2 text-sm">
                <FileText className="h-4 w-4 text-gray-400 shrink-0" />
                <span className="truncate flex-1" title={doc.fileName}>{doc.fileName}</span>
                <span className="text-xs text-gray-400">{fmtBytes(doc.fileSize)}</span>
                <Button type="button" variant="ghost" size="sm" asChild title="Abrir">
                  <a href={`/api/industria/documentos/${doc.id}/arquivo`} target="_blank" rel="noreferrer"><Eye className="h-4 w-4" /></a>
                </Button>
                <Button type="button" variant="ghost" size="sm" className="text-red-500 hover:text-red-600" onClick={() => setRemoverArquivo(true)} title="Remover arquivo"><Trash2 className="h-4 w-4" /></Button>
              </div>
            ) : (
              <p className="text-xs text-gray-400">
                {removerArquivo ? 'O arquivo atual será removido ao salvar.' : 'Nenhum arquivo. Aceita PDF, imagem, Word, Excel e texto — até 15MB.'}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Observações</Label>
            <Textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Número do protocolo, órgão emissor, responsável pela renovação…" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={save} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// aba
// ---------------------------------------------------------------------------
export default function DocumentosEmpresa() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [instFilter, setInstFilter] = useState('todas');
  const [statusFilter, setStatusFilter] = useState('todos');
  const [catFilter, setCatFilter] = useState('todas');
  const [dialog, setDialog] = useState<any>(null); // {} = novo, doc = editar
  const [catDialog, setCatDialog] = useState(false);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['/api/industria/documentos'],
    queryFn: () => jfetch('/api/industria/documentos'),
  });
  const { data: instData } = useQuery<any[]>({
    queryKey: ['/api/industria/documentos/instancias'],
    queryFn: () => jfetch('/api/industria/documentos/instancias'),
  });
  const { data: catData } = useQuery<any[]>({
    queryKey: ['/api/industria/documentos/categorias'],
    queryFn: () => jfetch('/api/industria/documentos/categorias'),
  });
  const categorias: any[] = catData || [];
  const instancias: any[] = instData?.length ? instData : FALLBACK_INSTANCIAS;
  const docs: any[] = data?.documentos || [];
  const resumo = data?.resumo || {};
  const diasAlerta = data?.diasAlerta ?? 30;

  const atualizar = () => qc.invalidateQueries({ queryKey: ['/api/industria/documentos'] });
  const atualizarCategorias = () => {
    qc.invalidateQueries({ queryKey: ['/api/industria/documentos/categorias'] });
    atualizar();
  };

  // Contagem por categoria para os cards clicáveis (mesmo padrão da aba Matéria-Prima).
  const cardsCategoria = useMemo(() => categorias.map((c) => {
    const list = docs.filter((d) => d.categoryId === c.id);
    return {
      ...c,
      count: list.length,
      vencidos: list.filter((d) => d.situacao === 'vencido' || d.status === 'vencido').length,
      aVencer: list.filter((d) => d.situacao === 'a_vencer').length,
    };
  }), [categorias, docs]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return docs.filter((d) => {
      if (instFilter !== 'todas' && d.instanceName !== instFilter) return false;
      if (catFilter !== 'todas' && d.categoryId !== catFilter) return false;
      if (statusFilter === 'a_vencer' && d.situacao !== 'a_vencer') return false;
      else if (statusFilter === 'vencido' && !(d.situacao === 'vencido' || d.status === 'vencido')) return false;
      else if (!['todos', 'a_vencer', 'vencido'].includes(statusFilter) && d.status !== statusFilter) return false;
      if (!s) return true;
      return [d.name, d.instanceName, d.notes, d.fileName].some((v) => String(v ?? '').toLowerCase().includes(s));
    });
  }, [docs, search, instFilter, statusFilter, catFilter]);

  const remover = async (d: any) => {
    if (!confirm(`Excluir o documento "${d.name}"${d.hasFile ? ' e o arquivo anexado' : ''}?`)) return;
    try {
      await jfetch(`/api/industria/documentos/${d.id}`, { method: 'DELETE' });
      toast({ title: 'Documento removido' });
      atualizar();
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' });
    }
  };

  const exportar = () => {
    exportToExcel(filtered.map((d) => ({
      'Documento': d.name,
      'Categoria': d.categoryName || '',
      'Instância': d.instanceName,
      'Vigência início': fmtDate(d.validFrom),
      'Vigência fim': fmtDate(d.validUntil),
      'Status': STATUS_LABEL[d.status] || d.status,
      'Situação': d.situacao === 'vencido' ? 'Vencido' : d.situacao === 'a_vencer' ? `Vence em ${d.diasRestantes} dia(s)` : d.situacao === 'em_dia' ? 'Em dia' : 'Sem vigência',
      'Arquivo': d.fileName || '',
      'Observações': d.notes || '',
    })), `documentos-empresa-${new Date().toISOString().slice(0, 10)}`);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-emerald-100 rounded-lg"><Files className="h-5 w-5 text-emerald-600" /></div>
          <div><p className="text-2xl font-bold">{resumo.total ?? 0}</p><p className="text-xs text-gray-500">Documentos</p></div>
        </CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-green-100 rounded-lg"><CheckCircle2 className="h-5 w-5 text-green-600" /></div>
          <div><p className="text-2xl font-bold">{resumo.vigentes ?? 0}</p><p className="text-xs text-gray-500">Vigentes</p></div>
        </CardContent></Card>
        <Card className={resumo.aVencer ? 'cursor-pointer hover:shadow' : ''} onClick={() => resumo.aVencer && setStatusFilter('a_vencer')}><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-amber-100 rounded-lg"><Clock className="h-5 w-5 text-amber-600" /></div>
          <div><p className="text-2xl font-bold">{resumo.aVencer ?? 0}</p><p className="text-xs text-gray-500">A vencer ({diasAlerta} dias)</p></div>
        </CardContent></Card>
        <Card className={resumo.vencidos ? 'cursor-pointer hover:shadow' : ''} onClick={() => resumo.vencidos && setStatusFilter('vencido')}><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-red-100 rounded-lg"><AlertTriangle className="h-5 w-5 text-red-600" /></div>
          <div><p className="text-2xl font-bold">{resumo.vencidos ?? 0}</p><p className="text-xs text-gray-500">Vencidos</p></div>
        </CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-gray-100 rounded-lg"><Paperclip className="h-5 w-5 text-gray-600" /></div>
          <div><p className="text-2xl font-bold">{resumo.semArquivo ?? 0}</p><p className="text-xs text-gray-500">Sem arquivo</p></div>
        </CardContent></Card>
      </div>

      {/* Categorias — cards clicáveis (filtro rápido), igual à aba Matéria-Prima */}
      {!!cardsCategoria.length && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
          {cardsCategoria.map((c) => (
            <Card key={c.id}
              className={`cursor-pointer ${catFilter === c.id ? 'ring-2 ring-emerald-500' : ''}`}
              onClick={() => setCatFilter(catFilter === c.id ? 'todas' : c.id)}>
              <CardContent className="p-3 text-center">
                <p className="text-xs text-gray-500 truncate" title={c.name}>{c.name}</p>
                <p className="text-xl font-bold">{c.count}</p>
                <div className="flex items-center justify-center gap-1 mt-1 min-h-[18px]">
                  {c.vencidos > 0 && <Badge className="bg-red-500 text-white hover:bg-red-500 text-[10px]">{c.vencidos} vencido(s)</Badge>}
                  {c.aVencer > 0 && <Badge className="bg-amber-500 text-white hover:bg-amber-500 text-[10px]">{c.aVencer} a vencer</Badge>}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
          <Input placeholder="Buscar documento..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 w-[240px]" />
        </div>
        <Select value={catFilter} onValueChange={setCatFilter}>
          <SelectTrigger className="w-[190px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todas">Todas as categorias</SelectItem>
            {categorias.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={instFilter} onValueChange={setInstFilter}>
          <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todas">Todas instâncias</SelectItem>
            {instancias.map((i) => <SelectItem key={i.name} value={i.name}>{i.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos os status</SelectItem>
            {STATUS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
            <SelectItem value="a_vencer">A vencer ({diasAlerta} dias)</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
        <span className="text-sm text-gray-500">{isLoading ? 'Carregando...' : `${filtered.length} documento(s)`}</span>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => setCatDialog(true)}>
          <Tags className="h-4 w-4 mr-1" /> Categorias
        </Button>
        <Button variant="outline" size="sm" onClick={exportar} disabled={!filtered.length}>
          <FileSpreadsheet className="h-4 w-4 mr-1" /> Excel
        </Button>
        <Button size="sm" onClick={() => setDialog({})} className="bg-emerald-600 hover:bg-emerald-700 text-white">
          <Plus className="h-4 w-4 mr-1" /> Novo documento
        </Button>
      </div>

      <div className="border rounded-lg overflow-auto max-h-[60vh]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Documento</TableHead>
              <TableHead>Categoria</TableHead>
              <TableHead>Instância</TableHead>
              <TableHead>Vigência</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Arquivo</TableHead>
              <TableHead>Obs.</TableHead>
              <TableHead className="w-[120px] text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={8} className="text-center py-8 text-gray-400"><Loader2 className="h-5 w-5 animate-spin inline" /></TableCell></TableRow>
            ) : !filtered.length ? (
              <TableRow><TableCell colSpan={8} className="text-center py-8 text-gray-400">
                {docs.length ? 'Nenhum documento com esse filtro.' : 'Nenhum documento cadastrado. Clique em "Novo documento" para começar.'}
              </TableCell></TableRow>
            ) : filtered.map((d) => (
              <TableRow key={d.id} className={d.situacao === 'vencido' ? 'bg-red-50/40' : d.situacao === 'a_vencer' ? 'bg-amber-50/40' : ''}>
                <TableCell className="font-medium">{d.name}</TableCell>
                <TableCell>
                  {d.categoryName
                    ? <Badge variant="outline" className={corClass(d.categoryColor)}>{d.categoryName}</Badge>
                    : <span className="text-xs text-gray-400">—</span>}
                </TableCell>
                <TableCell><Badge variant="outline">{d.instanceName}</Badge></TableCell>
                <TableCell><Vigencia doc={d} /></TableCell>
                <TableCell><Badge className={STATUS_CLASS[d.status] || ''}>{STATUS_LABEL[d.status] || d.status}</Badge></TableCell>
                <TableCell>
                  {d.hasFile ? (
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" asChild title={`Abrir ${d.fileName}`}>
                        <a href={`/api/industria/documentos/${d.id}/arquivo`} target="_blank" rel="noreferrer"><Eye className="h-4 w-4" /></a>
                      </Button>
                      <Button variant="ghost" size="sm" asChild title="Baixar">
                        <a href={`/api/industria/documentos/${d.id}/arquivo?download=1`}><Download className="h-4 w-4" /></a>
                      </Button>
                      <span className="text-[11px] text-gray-400 truncate max-w-[140px]" title={d.fileName}>{d.fileName}</span>
                    </div>
                  ) : <span className="text-xs text-gray-400">—</span>}
                </TableCell>
                <TableCell className="max-w-[220px] truncate text-sm text-gray-500" title={d.notes}>{d.notes || '-'}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => setDialog(d)} title="Editar"><Pencil className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-600" onClick={() => remover(d)} title="Excluir"><Trash2 className="h-4 w-4" /></Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {dialog && (
        <DocumentoDialog
          doc={dialog}
          instancias={instancias}
          categorias={categorias}
          onGerenciarCategorias={() => setCatDialog(true)}
          onClose={() => setDialog(null)}
          onDone={atualizar}
        />
      )}
      {catDialog && (
        <CategoriasDialog categorias={categorias} onClose={() => setCatDialog(false)} onDone={atualizarCategorias} />
      )}
    </div>
  );
}
