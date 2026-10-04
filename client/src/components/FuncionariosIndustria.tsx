// ============================================================================
// FUNCIONÁRIOS DA INDÚSTRIA — aba "Funcionários" do módulo Indústria (09/set/2026)
// Cadastro próprio dos funcionários da fábrica (não são usuários do Integra):
// nome · função · matrícula · telefone · instância · ativo · observações.
// 04/out/2026: + admissão · CPF · e-mail · CTPS/contrato · últimas férias e
// ANEXOS por funcionário (cópia de documentos, ASO, folhas de ponto, férias...).
// São eles que aparecem no select "Responsável" de cada item do check-list.
// Backend: /api/industria/funcionarios (server/checklist-industria-routes.ts).
// ============================================================================
import { useMemo, useRef, useState } from 'react';
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
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { exportToExcel } from '@/lib/tableTools';
import {
  Users, Search, Plus, RefreshCw, Pencil, Trash2, Loader2, FileSpreadsheet,
  UserCheck, UserX, Paperclip, Upload, ExternalLink, Download,
} from 'lucide-react';

const CATEGORIAS_ANEXO: Record<string, string> = {
  documentos_pessoais: 'Documentos pessoais',
  ctps_contrato: 'CTPS / Contrato',
  aso: 'ASO',
  folha_ponto: 'Folha de ponto',
  ferias: 'Férias',
  treinamentos: 'Treinamentos',
  outros: 'Outros',
};

export const fmtCpf = (v: string) => {
  const d = String(v || '').replace(/\D/g, '').slice(0, 11);
  if (d.length !== 11) return d;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
};
const maskCpf = (v: string) => {
  const d = String(v || '').replace(/\D/g, '').slice(0, 11);
  return d
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
};
const fmtData = (iso?: string | null) => {
  if (!iso) return '-';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : '-';
};
const fmtBytes = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

export const jfetchInd = async (url: string, opts: any = {}) => {
  const r = await fetch(url, {
    credentials: 'include',
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    ...opts,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(j?.error || j?.message || `Falha (${r.status})`);
  return j;
};

function AnexosFuncionario({ employeeId, onChanged }: { employeeId: string; onChanged: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const key = ['/api/industria/funcionarios', employeeId, 'anexos'];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => jfetchInd(`/api/industria/funcionarios/${employeeId}/anexos`) });
  const anexos: any[] = data?.anexos || [];
  const [category, setCategory] = useState('documentos_pessoais');
  const [description, setDescription] = useState('');
  const [referenceDate, setReferenceDate] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = () => { qc.invalidateQueries({ queryKey: key }); onChanged(); };

  const enviar = async () => {
    if (!file) { toast({ title: 'Selecione um arquivo', variant: 'destructive' }); return; }
    if (file.size > 15 * 1024 * 1024) { toast({ title: 'Arquivo acima de 15MB', variant: 'destructive' }); return; }
    setSending(true);
    try {
      const fd = new FormData();
      fd.append('arquivo', file);
      fd.append('category', category);
      if (description.trim()) fd.append('description', description.trim());
      if (referenceDate) fd.append('referenceDate', referenceDate);
      await jfetchInd(`/api/industria/funcionarios/${employeeId}/anexos`, { method: 'POST', body: fd });
      toast({ title: 'Anexo adicionado' });
      setFile(null); setDescription(''); setReferenceDate('');
      if (inputRef.current) inputRef.current.value = '';
      refresh();
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' });
    } finally { setSending(false); }
  };

  const remover = async (a: any) => {
    if (!confirm(`Remover o anexo "${a.fileName}"?`)) return;
    try {
      await jfetchInd(`/api/industria/funcionarios/${employeeId}/anexos/${a.id}`, { method: 'DELETE' });
      toast({ title: 'Anexo removido' });
      refresh();
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' });
    }
  };

  return (
    <div className="border-t pt-3 space-y-2">
      <div className="flex items-center gap-2">
        <Paperclip className="h-4 w-4 text-gray-500" />
        <span className="text-sm font-medium">Anexos</span>
        <span className="text-[11px] text-gray-400">cópia de documentos, ASO, folhas de ponto, férias, treinamentos… (até 15MB cada)</span>
      </div>
      <div className="grid grid-cols-12 gap-2 items-end bg-gray-50 rounded-md p-2">
        <div className="col-span-3 space-y-1">
          <Label className="text-[11px]">Tipo</Label>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(CATEGORIAS_ANEXO).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="col-span-3 space-y-1">
          <Label className="text-[11px]">Descrição</Label>
          <Input className="h-8 text-xs" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ex.: ASO admissional" />
        </div>
        <div className="col-span-2 space-y-1">
          <Label className="text-[11px]">Data ref.</Label>
          <Input type="date" className="h-8 text-xs" value={referenceDate} onChange={(e) => setReferenceDate(e.target.value)} />
        </div>
        <div className="col-span-3 space-y-1">
          <Label className="text-[11px]">Arquivo</Label>
          <Input ref={inputRef} type="file" className="h-8 text-xs" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </div>
        <div className="col-span-1">
          <Button size="sm" className="h-8 w-full bg-emerald-600 hover:bg-emerald-700 text-white" onClick={enviar} disabled={sending || !file} title="Anexar">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          </Button>
        </div>
      </div>
      {isLoading ? (
        <p className="text-xs text-gray-400"><Loader2 className="h-3 w-3 animate-spin inline mr-1" />Carregando anexos...</p>
      ) : !anexos.length ? (
        <p className="text-xs text-gray-400">Nenhum anexo.</p>
      ) : (
        <div className="border rounded-md divide-y max-h-[220px] overflow-y-auto">
          {anexos.map((a) => (
            <div key={a.id} className="flex items-center gap-2 px-2 py-1.5 text-xs">
              <Badge variant="outline" className="shrink-0">{CATEGORIAS_ANEXO[a.category] || a.category}</Badge>
              <div className="flex-1 min-w-0">
                <div className="truncate font-medium" title={a.fileName}>{a.fileName}</div>
                <div className="text-gray-400 truncate">
                  {a.description ? `${a.description} · ` : ''}{a.referenceDate ? `ref. ${fmtData(a.referenceDate)} · ` : ''}{fmtBytes(a.fileSize)} · {fmtData(String(a.createdAt).slice(0, 10))}
                </div>
              </div>
              <a href={a.url} target="_blank" rel="noreferrer" title="Abrir"><Button variant="ghost" size="sm" className="h-7 w-7 p-0"><ExternalLink className="h-3.5 w-3.5" /></Button></a>
              <a href={`${a.url}?download=1`} title="Baixar"><Button variant="ghost" size="sm" className="h-7 w-7 p-0"><Download className="h-3.5 w-3.5" /></Button></a>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-500 hover:text-red-600" onClick={() => remover(a)} title="Remover"><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FuncionarioDialog({ func, onClose, onDone }: { func: any; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const isNew = !func?.id;
  const [f, setF] = useState({
    name: func?.name || '',
    roleName: func?.roleName || '',
    registration: func?.registration || '',
    phone: func?.phone || '',
    instanceName: func?.instanceName || 'IND',
    isActive: func?.isActive !== false,
    notes: func?.notes || '',
    admissionDate: func?.admissionDate || '',
    cpf: maskCpf(func?.cpf || ''),
    email: func?.email || '',
    workCardNumber: func?.workCardNumber || '',
    lastVacationDate: func?.lastVacationDate || '',
  });
  const [saving, setSaving] = useState(false);
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));

  const save = async () => {
    if (!f.name.trim()) { toast({ title: 'Informe o nome', variant: 'destructive' }); return; }
    const cpfDigits = f.cpf.replace(/\D/g, '');
    if (cpfDigits && cpfDigits.length !== 11) { toast({ title: 'CPF deve ter 11 dígitos', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      const payload = { ...f, cpf: cpfDigits, admissionDate: f.admissionDate || null, lastVacationDate: f.lastVacationDate || null };
      if (isNew) await jfetchInd('/api/industria/funcionarios', { method: 'POST', body: JSON.stringify(payload) });
      else await jfetchInd(`/api/industria/funcionarios/${func.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      toast({ title: isNew ? 'Funcionário cadastrado' : 'Funcionário atualizado' });
      onDone();
      onClose();
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{isNew ? 'Novo funcionário' : `Editar — ${func.name}`}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Nome *</Label>
            <Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Nome do funcionário" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Função</Label>
              <Input value={f.roleName} onChange={(e) => set('roleName', e.target.value)} placeholder="Ex.: Envasador, Líder de produção" />
            </div>
            <div className="space-y-1.5">
              <Label>Matrícula</Label>
              <Input value={f.registration} onChange={(e) => set('registration', e.target.value)} placeholder="Opcional" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Telefone</Label>
              <Input value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="Opcional" />
            </div>
            <div className="space-y-1.5">
              <Label>Instância</Label>
              <Select value={f.instanceName} onValueChange={(v) => set('instanceName', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="IND">IND — Indústria</SelectItem>
                  <SelectItem value="GYN">GYN</SelectItem>
                  <SelectItem value="SERV">SERV</SelectItem>
                  <SelectItem value="BSB">BSB</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>CPF</Label>
              <Input value={f.cpf} onChange={(e) => set('cpf', maskCpf(e.target.value))} placeholder="000.000.000-00" inputMode="numeric" />
            </div>
            <div className="space-y-1.5">
              <Label>E-mail</Label>
              <Input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} placeholder="nome@exemplo.com" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Data de admissão</Label>
              <Input type="date" value={f.admissionDate} onChange={(e) => set('admissionDate', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Nº CTPS ou contrato</Label>
              <Input value={f.workCardNumber} onChange={(e) => set('workCardNumber', e.target.value)} placeholder="Carteira de trabalho ou nº do contrato" />
            </div>
            <div className="space-y-1.5">
              <Label>Últimas férias</Label>
              <Input type="date" value={f.lastVacationDate} onChange={(e) => set('lastVacationDate', e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Observações</Label>
            <Textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Checkbox checked={f.isActive} onCheckedChange={(v) => set('isActive', v === true)} />
            <span className="text-sm">{f.isActive ? 'Ativo' : 'Inativo'}</span>
            <span className="text-[11px] text-gray-400">Inativos não aparecem no check-list.</span>
          </div>
          {isNew ? (
            <p className="text-[11px] text-gray-400 border-t pt-2">Salve o cadastro para poder adicionar anexos (documentos, ASO, folhas de ponto...).</p>
          ) : (
            <AnexosFuncionario employeeId={func.id} onChanged={onDone} />
          )}
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

export default function FuncionariosIndustria() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [verInativos, setVerInativos] = useState(true);
  const [dialog, setDialog] = useState<any>(null);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['/api/industria/funcionarios', verInativos],
    queryFn: () => jfetchInd(`/api/industria/funcionarios${verInativos ? '?incluirInativos=1' : ''}`),
  });
  const funcs: any[] = data?.funcionarios || [];
  const resumo = data?.resumo || {};
  const atualizar = () => qc.invalidateQueries({ queryKey: ['/api/industria/funcionarios'] });

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return funcs;
    return funcs.filter((f) => [f.name, f.roleName, f.registration, f.phone, f.cpf, f.email, f.workCardNumber].some((v) => String(v ?? '').toLowerCase().includes(s)));
  }, [funcs, search]);

  const remover = async (f: any) => {
    if (!confirm(`Excluir o funcionário "${f.name}"?\n(Se ele já respondeu algum check-list, será apenas inativado.)`)) return;
    try {
      const r = await jfetchInd(`/api/industria/funcionarios/${f.id}`, { method: 'DELETE' });
      toast({ title: r?.message || 'Funcionário removido' });
      atualizar();
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' });
    }
  };

  const exportar = () => {
    exportToExcel(filtered.map((f) => ({
      'Nome': f.name, 'Função': f.roleName, 'Matrícula': f.registration,
      'CPF': fmtCpf(f.cpf), 'E-mail': f.email, 'Telefone': f.phone,
      'Admissão': fmtData(f.admissionDate), 'CTPS/Contrato': f.workCardNumber,
      'Últimas férias': fmtData(f.lastVacationDate), 'Anexos': f.attachmentsCount ?? 0,
      'Instância': f.instanceName,
      'Situação': f.isActive ? 'Ativo' : 'Inativo', 'Observações': f.notes,
    })), `funcionarios-industria-${new Date().toISOString().slice(0, 10)}`);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-emerald-100 rounded-lg"><Users className="h-5 w-5 text-emerald-600" /></div>
          <div><p className="text-2xl font-bold">{resumo.total ?? 0}</p><p className="text-xs text-gray-500">Funcionários</p></div>
        </CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-green-100 rounded-lg"><UserCheck className="h-5 w-5 text-green-600" /></div>
          <div><p className="text-2xl font-bold">{resumo.ativos ?? 0}</p><p className="text-xs text-gray-500">Ativos</p></div>
        </CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-gray-100 rounded-lg"><UserX className="h-5 w-5 text-gray-600" /></div>
          <div><p className="text-2xl font-bold">{resumo.inativos ?? 0}</p><p className="text-xs text-gray-500">Inativos</p></div>
        </CardContent></Card>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
          <Input placeholder="Buscar funcionário..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 w-[240px]" />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <Checkbox checked={verInativos} onCheckedChange={(v) => setVerInativos(v === true)} /> Mostrar inativos
        </label>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
        <span className="text-sm text-gray-500">{isLoading ? 'Carregando...' : `${filtered.length} funcionário(s)`}</span>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={exportar} disabled={!filtered.length}>
          <FileSpreadsheet className="h-4 w-4 mr-1" /> Excel
        </Button>
        <Button size="sm" onClick={() => setDialog({})} className="bg-emerald-600 hover:bg-emerald-700 text-white">
          <Plus className="h-4 w-4 mr-1" /> Novo funcionário
        </Button>
      </div>

      <div className="border rounded-lg overflow-auto max-h-[60vh]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>Função</TableHead>
              <TableHead>Matrícula</TableHead>
              <TableHead>CPF</TableHead>
              <TableHead>Telefone</TableHead>
              <TableHead>Admissão</TableHead>
              <TableHead>Últimas férias</TableHead>
              <TableHead>Instância</TableHead>
              <TableHead>Situação</TableHead>
              <TableHead className="w-[140px] text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={11} className="text-center py-8 text-gray-400"><Loader2 className="h-5 w-5 animate-spin inline" /></TableCell></TableRow>
            ) : !filtered.length ? (
              <TableRow><TableCell colSpan={11} className="text-center py-8 text-gray-400">
                {funcs.length ? 'Nenhum funcionário com esse filtro.' : 'Nenhum funcionário cadastrado. Clique em "Novo funcionário".'}
              </TableCell></TableRow>
            ) : filtered.map((f) => (
              <TableRow key={f.id} className={f.isActive ? '' : 'opacity-60'}>
                <TableCell className="font-medium">{f.name}</TableCell>
                <TableCell>{f.roleName || '-'}</TableCell>
                <TableCell>{f.registration || '-'}</TableCell>
                <TableCell className="whitespace-nowrap">{f.cpf ? fmtCpf(f.cpf) : '-'}</TableCell>
                <TableCell>{f.phone || '-'}</TableCell>
                <TableCell className="whitespace-nowrap">{fmtData(f.admissionDate)}</TableCell>
                <TableCell className="whitespace-nowrap">{fmtData(f.lastVacationDate)}</TableCell>
                <TableCell><Badge variant="outline">{f.instanceName}</Badge></TableCell>
                <TableCell>
                  <Badge className={f.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-700'}>
                    {f.isActive ? 'Ativo' : 'Inativo'}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => setDialog(f)} title="Anexos" className="relative">
                    <Paperclip className="h-4 w-4" />
                    {f.attachmentsCount > 0 && <span className="absolute -top-0.5 -right-0.5 bg-emerald-600 text-white text-[9px] rounded-full h-4 min-w-4 px-1 flex items-center justify-center">{f.attachmentsCount}</span>}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setDialog(f)} title="Editar"><Pencil className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-600" onClick={() => remover(f)} title="Excluir"><Trash2 className="h-4 w-4" /></Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {dialog && <FuncionarioDialog func={dialog} onClose={() => setDialog(null)} onDone={atualizar} />}
    </div>
  );
}
