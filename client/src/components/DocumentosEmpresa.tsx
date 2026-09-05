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
  Loader2, FileSpreadsheet, CheckCircle2, AlertTriangle, Clock, Paperclip, X, Files,
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
// dialog novo / editar
// ---------------------------------------------------------------------------
function DocumentoDialog({ doc, instancias, onClose, onDone }: { doc: any; instancias: any[]; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const isNew = !doc?.id;
  const [f, setF] = useState({
    name: doc?.name || '',
    instanceName: doc?.instanceName || (instancias[0]?.name ?? 'IND'),
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
  const [dialog, setDialog] = useState<any>(null); // {} = novo, doc = editar

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['/api/industria/documentos'],
    queryFn: () => jfetch('/api/industria/documentos'),
  });
  const { data: instData } = useQuery<any[]>({
    queryKey: ['/api/industria/documentos/instancias'],
    queryFn: () => jfetch('/api/industria/documentos/instancias'),
  });
  const instancias: any[] = instData?.length ? instData : FALLBACK_INSTANCIAS;
  const docs: any[] = data?.documentos || [];
  const resumo = data?.resumo || {};
  const diasAlerta = data?.diasAlerta ?? 30;

  const atualizar = () => qc.invalidateQueries({ queryKey: ['/api/industria/documentos'] });

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return docs.filter((d) => {
      if (instFilter !== 'todas' && d.instanceName !== instFilter) return false;
      if (statusFilter === 'a_vencer' && d.situacao !== 'a_vencer') return false;
      else if (statusFilter === 'vencido' && !(d.situacao === 'vencido' || d.status === 'vencido')) return false;
      else if (!['todos', 'a_vencer', 'vencido'].includes(statusFilter) && d.status !== statusFilter) return false;
      if (!s) return true;
      return [d.name, d.instanceName, d.notes, d.fileName].some((v) => String(v ?? '').toLowerCase().includes(s));
    });
  }, [docs, search, instFilter, statusFilter]);

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

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
          <Input placeholder="Buscar documento..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 w-[240px]" />
        </div>
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
              <TableRow><TableCell colSpan={7} className="text-center py-8 text-gray-400"><Loader2 className="h-5 w-5 animate-spin inline" /></TableCell></TableRow>
            ) : !filtered.length ? (
              <TableRow><TableCell colSpan={7} className="text-center py-8 text-gray-400">
                {docs.length ? 'Nenhum documento com esse filtro.' : 'Nenhum documento cadastrado. Clique em "Novo documento" para começar.'}
              </TableCell></TableRow>
            ) : filtered.map((d) => (
              <TableRow key={d.id} className={d.situacao === 'vencido' ? 'bg-red-50/40' : d.situacao === 'a_vencer' ? 'bg-amber-50/40' : ''}>
                <TableCell className="font-medium">{d.name}</TableCell>
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
        <DocumentoDialog doc={dialog} instancias={instancias} onClose={() => setDialog(null)} onDone={atualizar} />
      )}
    </div>
  );
}
