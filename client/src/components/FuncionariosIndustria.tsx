// ============================================================================
// FUNCIONÁRIOS DA INDÚSTRIA — aba "Funcionários" do módulo Indústria (09/set/2026)
// Cadastro próprio dos funcionários da fábrica (não são usuários do Integra):
// nome · função · matrícula · telefone · instância · ativo · observações.
// São eles que aparecem no select "Responsável" de cada item do check-list.
// Backend: /api/industria/funcionarios (server/checklist-industria-routes.ts).
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
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { exportToExcel } from '@/lib/tableTools';
import {
  Users, Search, Plus, RefreshCw, Pencil, Trash2, Loader2, FileSpreadsheet,
  UserCheck, UserX,
} from 'lucide-react';

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
  });
  const [saving, setSaving] = useState(false);
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));

  const save = async () => {
    if (!f.name.trim()) { toast({ title: 'Informe o nome', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      if (isNew) await jfetchInd('/api/industria/funcionarios', { method: 'POST', body: JSON.stringify(f) });
      else await jfetchInd(`/api/industria/funcionarios/${func.id}`, { method: 'PATCH', body: JSON.stringify(f) });
      toast({ title: isNew ? 'Funcionário cadastrado' : 'Funcionário atualizado' });
      onDone();
      onClose();
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
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
          <div className="space-y-1.5">
            <Label>Observações</Label>
            <Textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Checkbox checked={f.isActive} onCheckedChange={(v) => set('isActive', v === true)} />
            <span className="text-sm">{f.isActive ? 'Ativo' : 'Inativo'}</span>
            <span className="text-[11px] text-gray-400">Inativos não aparecem no check-list.</span>
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
    return funcs.filter((f) => [f.name, f.roleName, f.registration, f.phone].some((v) => String(v ?? '').toLowerCase().includes(s)));
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
      'Telefone': f.phone, 'Instância': f.instanceName,
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
              <TableHead>Telefone</TableHead>
              <TableHead>Instância</TableHead>
              <TableHead>Situação</TableHead>
              <TableHead className="w-[110px] text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={7} className="text-center py-8 text-gray-400"><Loader2 className="h-5 w-5 animate-spin inline" /></TableCell></TableRow>
            ) : !filtered.length ? (
              <TableRow><TableCell colSpan={7} className="text-center py-8 text-gray-400">
                {funcs.length ? 'Nenhum funcionário com esse filtro.' : 'Nenhum funcionário cadastrado. Clique em "Novo funcionário".'}
              </TableCell></TableRow>
            ) : filtered.map((f) => (
              <TableRow key={f.id} className={f.isActive ? '' : 'opacity-60'}>
                <TableCell className="font-medium">{f.name}</TableCell>
                <TableCell>{f.roleName || '-'}</TableCell>
                <TableCell>{f.registration || '-'}</TableCell>
                <TableCell>{f.phone || '-'}</TableCell>
                <TableCell><Badge variant="outline">{f.instanceName}</Badge></TableCell>
                <TableCell>
                  <Badge className={f.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-700'}>
                    {f.isActive ? 'Ativo' : 'Inativo'}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
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
