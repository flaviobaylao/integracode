// ============================================================================
// CHECK LIST DA INDÚSTRIA — aba "Check List" do módulo Indústria (09/set/2026)
// ---------------------------------------------------------------------------
// Duas visões:
//   • MODELOS   — cadastro dos tipos de check-list (Produção, Despolpamento,
//                 Limpeza…) e dos itens que devem ser registrados em cada um.
//   • EXECUÇÕES — o preenchimento do dia a dia: abre-se uma execução de um
//                 modelo (data/turno) e cada item recebe responsável,
//                 conforme/não conforme, observação e FOTO.
//
// FOTO — dois caminhos, como o Flavio pediu:
//   📷 "Tirar foto"  → input capture="environment": abre a câmera do celular.
//      A data e a hora do evento são carimbadas automaticamente pelo servidor.
//   📎 "Anexar foto" → escolhe da galeria/computador. Nesse caso a data e a
//      hora do evento são DIGITADAS (campo obrigatório).
//
// Backend: /api/industria/checklists*, /api/industria/checklist-execucoes*
// (server/checklist-industria-routes.ts).
// ============================================================================
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { exportToExcel } from '@/lib/tableTools';
import {
  ClipboardList, ClipboardCheck, Search, Plus, RefreshCw, Pencil, Trash2, Loader2,
  FileSpreadsheet, Camera, Upload, Image as ImageIcon, CheckCircle2, XCircle,
  AlertTriangle, Clock, ArrowLeft, ArrowUp, ArrowDown, Lock, Unlock, Eye,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const jfetch = async (url: string, opts: any = {}) => {
  const r = await fetch(url, {
    credentials: 'include',
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    ...opts,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(j?.error || j?.message || `Falha (${r.status})`);
  return j;
};

const MAX_FOTO = 10 * 1024 * 1024;

const CONFORMIDADE = [
  { value: 'conforme', label: 'Conforme' },
  { value: 'nao_conforme', label: 'Não conforme' },
  { value: 'na', label: 'Não se aplica' },
];
const CONF_LABEL: Record<string, string> = Object.fromEntries(CONFORMIDADE.map((c) => [c.value, c.label]));
const CONF_CLASS: Record<string, string> = {
  conforme: 'bg-green-100 text-green-700',
  nao_conforme: 'bg-red-100 text-red-700',
  na: 'bg-gray-200 text-gray-700',
};
const RUN_STATUS_LABEL: Record<string, string> = {
  aberta: 'Em preenchimento', concluida: 'Concluído', cancelada: 'Cancelado',
};
const RUN_STATUS_CLASS: Record<string, string> = {
  aberta: 'bg-amber-100 text-amber-700',
  concluida: 'bg-green-100 text-green-700',
  cancelada: 'bg-gray-200 text-gray-700',
};

const hojeISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const fmtDate = (v: any) => {
  if (!v) return '-';
  const [y, m, d] = String(v).slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : String(v);
};
const fmtDateTime = (v: any) => {
  if (!v) return '-';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
// valor inicial para <input type="datetime-local"> no horário de Brasília
const agoraLocal = () => {
  const d = new Date();
  const br = new Date(d.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${br.getFullYear()}-${p(br.getMonth() + 1)}-${p(br.getDate())}T${p(br.getHours())}:${p(br.getMinutes())}`;
};

// ===========================================================================
// MODELOS — dialog de cadastro/edição (com os itens)
// ===========================================================================
function ModeloDialog({ modelo, onClose, onDone }: { modelo: any; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const isNew = !modelo?.id;
  const [name, setName] = useState(modelo?.name || '');
  const [description, setDescription] = useState(modelo?.description || '');
  const [isActive, setIsActive] = useState(modelo?.isActive !== false);
  const [itens, setItens] = useState<any[]>(
    (modelo?.itens || []).map((i: any) => ({ ...i })) // itens existentes
  );
  const [novoItem, setNovoItem] = useState('');
  const [novoFoto, setNovoFoto] = useState(false);
  const [saving, setSaving] = useState(false);

  const addItem = () => {
    const t = novoItem.trim();
    if (!t) return;
    setItens((p) => [...p, { id: null, title: t, description: '', requiresPhoto: novoFoto }]);
    setNovoItem('');
    setNovoFoto(false);
  };
  const mover = (idx: number, delta: number) => {
    setItens((p) => {
      const n = [...p];
      const alvo = idx + delta;
      if (alvo < 0 || alvo >= n.length) return p;
      [n[idx], n[alvo]] = [n[alvo], n[idx]];
      return n;
    });
  };
  const setItem = (idx: number, k: string, v: any) =>
    setItens((p) => p.map((it, i) => (i === idx ? { ...it, [k]: v } : it)));

  const save = async () => {
    if (!name.trim()) { toast({ title: 'Informe o nome do check-list', variant: 'destructive' }); return; }
    if (!itens.length) { toast({ title: 'Adicione pelo menos um item', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      if (isNew) {
        await jfetch('/api/industria/checklists', {
          method: 'POST',
          body: JSON.stringify({ name, description, isActive, itens }),
        });
      } else {
        await jfetch(`/api/industria/checklists/${modelo.id}`, {
          method: 'PATCH', body: JSON.stringify({ name, description, isActive }),
        });
        // sincroniza itens: cria os novos, atualiza os existentes, apaga os removidos
        const originais: any[] = modelo.itens || [];
        const mantidos = new Set(itens.filter((i) => i.id).map((i) => i.id));
        for (const o of originais) {
          if (!mantidos.has(o.id)) {
            await jfetch(`/api/industria/checklists/${modelo.id}/itens/${o.id}`, { method: 'DELETE' });
          }
        }
        const ordem: string[] = [];
        for (const it of itens) {
          if (it.id) {
            await jfetch(`/api/industria/checklists/${modelo.id}/itens/${it.id}`, {
              method: 'PATCH',
              body: JSON.stringify({ title: it.title, description: it.description, requiresPhoto: it.requiresPhoto }),
            });
            ordem.push(it.id);
          } else {
            const r = await jfetch(`/api/industria/checklists/${modelo.id}/itens`, {
              method: 'POST',
              body: JSON.stringify({ title: it.title, description: it.description, requiresPhoto: it.requiresPhoto }),
            });
            ordem.push(r?.item?.id);
          }
        }
        await jfetch(`/api/industria/checklists/${modelo.id}/ordem`, {
          method: 'PATCH', body: JSON.stringify({ ordem: ordem.filter(Boolean) }),
        });
      }
      toast({ title: isNew ? 'Check-list cadastrado' : 'Check-list atualizado' });
      onDone();
      onClose();
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Novo check-list' : `Editar — ${modelo.name}`}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Nome do check-list *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Check-list de Produção, de Despolpamento, de Limpeza…" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label>Descrição</Label>
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Quando e por quem esse check-list deve ser preenchido." />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={isActive} onCheckedChange={(v) => setIsActive(v === true)} />
            Ativo (aparece na hora de abrir uma execução)
          </label>

          <div className="rounded-md border p-3 space-y-2">
            <Label className="flex items-center gap-1.5"><ClipboardList className="h-4 w-4" /> Itens do check-list *</Label>
            {!itens.length && <p className="text-xs text-gray-400">Nenhum item ainda. Adicione abaixo.</p>}
            {itens.map((it, idx) => (
              <div key={it.id || `novo-${idx}`} className="flex items-start gap-2 border rounded-md p-2">
                <span className="text-xs text-gray-400 pt-2 w-5 text-right">{idx + 1}</span>
                <div className="flex-1 space-y-1.5">
                  <Input value={it.title} onChange={(e) => setItem(idx, 'title', e.target.value)} placeholder="Descrição do item" />
                  <Input value={it.description || ''} onChange={(e) => setItem(idx, 'description', e.target.value)}
                    placeholder="Orientação/observação (opcional)" className="text-xs" />
                  <label className="flex items-center gap-2 text-xs text-gray-600">
                    <Checkbox checked={!!it.requiresPhoto} onCheckedChange={(v) => setItem(idx, 'requiresPhoto', v === true)} />
                    <Camera className="h-3.5 w-3.5" /> Foto obrigatória neste item
                  </label>
                </div>
                <div className="flex flex-col gap-1">
                  <Button variant="ghost" size="sm" onClick={() => mover(idx, -1)} disabled={idx === 0} title="Subir"><ArrowUp className="h-3.5 w-3.5" /></Button>
                  <Button variant="ghost" size="sm" onClick={() => mover(idx, 1)} disabled={idx === itens.length - 1} title="Descer"><ArrowDown className="h-3.5 w-3.5" /></Button>
                  <Button variant="ghost" size="sm" className="text-red-500" onClick={() => setItens((p) => p.filter((_, i) => i !== idx))} title="Remover"><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </div>
            ))}
            <div className="flex items-center gap-2 pt-1">
              <Input value={novoItem} onChange={(e) => setNovoItem(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } }}
                placeholder="Novo item — ex.: Higienização da esteira" />
              <label className="flex items-center gap-1.5 text-xs text-gray-600 whitespace-nowrap">
                <Checkbox checked={novoFoto} onCheckedChange={(v) => setNovoFoto(v === true)} /> exige foto
              </label>
              <Button variant="outline" size="sm" onClick={addItem}><Plus className="h-4 w-4 mr-1" /> Adicionar</Button>
            </div>
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

// ===========================================================================
// MODELOS — lista
// ===========================================================================
function ModelosView() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<any>(null);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['/api/industria/checklists'],
    queryFn: () => jfetch('/api/industria/checklists?incluirInativos=1'),
  });
  const modelos: any[] = data?.checklists || [];
  const resumo = data?.resumo || {};
  const atualizar = () => qc.invalidateQueries({ queryKey: ['/api/industria/checklists'] });

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return modelos;
    return modelos.filter((m) => [m.name, m.description].some((v) => String(v ?? '').toLowerCase().includes(s)));
  }, [modelos, search]);

  const remover = async (m: any) => {
    if (!confirm(`Excluir o check-list "${m.name}"?\n(Se já houver execuções, ele será apenas inativado.)`)) return;
    try {
      const r = await jfetch(`/api/industria/checklists/${m.id}`, { method: 'DELETE' });
      toast({ title: r?.message || 'Check-list removido' });
      atualizar();
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-emerald-100 rounded-lg"><ClipboardList className="h-5 w-5 text-emerald-600" /></div>
          <div><p className="text-2xl font-bold">{resumo.total ?? 0}</p><p className="text-xs text-gray-500">Check-lists</p></div>
        </CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-green-100 rounded-lg"><CheckCircle2 className="h-5 w-5 text-green-600" /></div>
          <div><p className="text-2xl font-bold">{resumo.ativos ?? 0}</p><p className="text-xs text-gray-500">Ativos</p></div>
        </CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 bg-gray-100 rounded-lg"><ClipboardCheck className="h-5 w-5 text-gray-600" /></div>
          <div><p className="text-2xl font-bold">{resumo.itens ?? 0}</p><p className="text-xs text-gray-500">Itens cadastrados</p></div>
        </CardContent></Card>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
          <Input placeholder="Buscar check-list..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 w-[240px]" />
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
        <span className="text-sm text-gray-500">{isLoading ? 'Carregando...' : `${filtered.length} check-list(s)`}</span>
        <div className="flex-1" />
        <Button size="sm" onClick={() => setDialog({})} className="bg-emerald-600 hover:bg-emerald-700 text-white">
          <Plus className="h-4 w-4 mr-1" /> Novo check-list
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {isLoading ? (
          <div className="col-span-2 text-center py-8 text-gray-400"><Loader2 className="h-5 w-5 animate-spin inline" /></div>
        ) : !filtered.length ? (
          <div className="col-span-2 text-center py-8 text-gray-400">
            {modelos.length ? 'Nenhum check-list com esse filtro.' : 'Nenhum check-list cadastrado. Comece com "Novo check-list" — ex.: Produção, Despolpamento, Limpeza.'}
          </div>
        ) : filtered.map((m) => (
          <Card key={m.id} className={m.isActive ? '' : 'opacity-60'}>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{m.name}</p>
                  {m.description && <p className="text-xs text-gray-500">{m.description}</p>}
                </div>
                <div className="flex items-center gap-1">
                  {!m.isActive && <Badge className="bg-gray-200 text-gray-700">Inativo</Badge>}
                  <Button variant="ghost" size="sm" onClick={() => setDialog(m)} title="Editar"><Pencil className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-600" onClick={() => remover(m)} title="Excluir"><Trash2 className="h-4 w-4" /></Button>
                </div>
              </div>
              <ol className="text-sm space-y-1 list-decimal list-inside">
                {(m.itens || []).slice(0, 6).map((i: any) => (
                  <li key={i.id} className="text-gray-700">
                    {i.title}
                    {i.requiresPhoto && <Camera className="h-3.5 w-3.5 inline ml-1 text-emerald-600" />}
                  </li>
                ))}
                {(m.itens || []).length > 6 && <li className="text-gray-400 list-none">+ {(m.itens || []).length - 6} item(ns)…</li>}
              </ol>
              <p className="text-[11px] text-gray-400">{m.totalItens} item(ns)</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {dialog && <ModeloDialog modelo={dialog} onClose={() => setDialog(null)} onDone={atualizar} />}
    </div>
  );
}

// ===========================================================================
// EXECUÇÃO — card de um item (responsável, conformidade, foto)
// ===========================================================================
function ItemExecucao({ run, item, funcionarios, onDone, bloqueado }:
  { run: any; item: any; funcionarios: any[]; onDone: () => void; bloqueado: boolean }) {
  const { toast } = useToast();
  const [saving, setSaving] = useState<string | null>(null);
  const [notes, setNotes] = useState(item.notes || '');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadWhen, setUploadWhen] = useState(agoraLocal());
  const camId = `cam-${item.id}`;
  const upId = `up-${item.id}`;

  const enviar = async (fd: FormData, tag: string) => {
    setSaving(tag);
    try {
      await jfetch(`/api/industria/checklist-execucoes/${run.id}/itens/${item.id}`, { method: 'PATCH', body: fd });
      onDone();
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' });
    } finally { setSaving(null); }
  };

  const setCampo = (campo: string, valor: string) => {
    const fd = new FormData();
    fd.append(campo, valor);
    enviar(fd, campo);
  };

  // 📷 foto tirada na hora — data e hora vêm do próprio registro
  const tirarFoto = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (file.size > MAX_FOTO) { toast({ title: 'Foto acima de 10MB', variant: 'destructive' }); return; }
    const fd = new FormData();
    fd.append('foto', file);
    fd.append('fonte', 'camera');
    enviar(fd, 'foto');
  };

  // 📎 foto da galeria — data e hora digitadas
  const anexarFoto = () => {
    if (!uploadFile) return;
    if (!uploadWhen) { toast({ title: 'Informe a data e a hora do evento', variant: 'destructive' }); return; }
    const fd = new FormData();
    fd.append('foto', uploadFile);
    fd.append('fonte', 'upload');
    fd.append('eventAt', uploadWhen);
    enviar(fd, 'foto').then(() => setUploadFile(null));
  };

  const conf = item.conformidade;

  return (
    <Card className={
      conf === 'nao_conforme' ? 'border-red-300 bg-red-50/40'
        : item.pendente ? 'border-amber-300 bg-amber-50/30' : 'border-green-200'
    }>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-medium text-sm">
              {item.position + 1}. {item.title}
              {item.requiresPhoto && <Camera className="h-3.5 w-3.5 inline ml-1 text-emerald-600" />}
            </p>
            {item.description && <p className="text-[11px] text-gray-500">{item.description}</p>}
          </div>
          {conf
            ? <Badge className={CONF_CLASS[conf]}>{CONF_LABEL[conf]}</Badge>
            : <Badge className="bg-amber-100 text-amber-700">Pendente</Badge>}
        </div>

        <div className="grid gap-2 md:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-[11px] text-gray-500">Responsável</Label>
            <Select value={item.employeeId || ''} onValueChange={(v) => setCampo('employeeId', v)} disabled={bloqueado}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Selecione o funcionário" /></SelectTrigger>
              <SelectContent>
                {funcionarios.map((f) => (
                  <SelectItem key={f.id} value={f.id}>{f.name}{f.roleName ? ` — ${f.roleName}` : ''}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-gray-500">Conformidade</Label>
            <div className="flex gap-1">
              <Button size="sm" variant={conf === 'conforme' ? 'default' : 'outline'} disabled={bloqueado || saving === 'conformidade'}
                className={conf === 'conforme' ? 'bg-green-600 hover:bg-green-700 text-white' : ''}
                onClick={() => setCampo('conformidade', 'conforme')}>
                <CheckCircle2 className="h-4 w-4 mr-1" /> Conforme
              </Button>
              <Button size="sm" variant={conf === 'nao_conforme' ? 'default' : 'outline'} disabled={bloqueado || saving === 'conformidade'}
                className={conf === 'nao_conforme' ? 'bg-red-600 hover:bg-red-700 text-white' : ''}
                onClick={() => setCampo('conformidade', 'nao_conforme')}>
                <XCircle className="h-4 w-4 mr-1" /> Não conforme
              </Button>
              <Button size="sm" variant={conf === 'na' ? 'secondary' : 'outline'} disabled={bloqueado || saving === 'conformidade'}
                onClick={() => setCampo('conformidade', 'na')} title="Não se aplica">N/A</Button>
            </div>
          </div>
        </div>

        {/* FOTO */}
        <div className="rounded-md border p-2 space-y-2">
          {item.hasPhoto ? (
            <div className="flex items-start gap-3">
              <a href={`/api/industria/checklist-execucoes/${run.id}/itens/${item.id}/foto`} target="_blank" rel="noreferrer" title="Abrir foto">
                <img src={`/api/industria/checklist-execucoes/${run.id}/itens/${item.id}/foto`}
                  alt={item.title} className="h-20 w-20 object-cover rounded border" />
              </a>
              <div className="text-xs space-y-0.5">
                <p className="flex items-center gap-1">
                  {item.photoSource === 'camera'
                    ? <><Camera className="h-3.5 w-3.5 text-emerald-600" /> Foto tirada na hora</>
                    : <><Upload className="h-3.5 w-3.5 text-blue-600" /> Foto anexada</>}
                </p>
                <p className="text-gray-600 flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {fmtDateTime(item.eventAt)}</p>
                {item.employeeName && <p className="text-gray-500">Responsável: {item.employeeName}</p>}
                {!bloqueado && (
                  <Button variant="ghost" size="sm" className="text-red-500 h-7 px-1"
                    onClick={() => { const fd = new FormData(); fd.append('removerFoto', '1'); enviar(fd, 'foto'); }}>
                    <Trash2 className="h-3.5 w-3.5 mr-1" /> Remover foto
                  </Button>
                )}
              </div>
            </div>
          ) : bloqueado ? (
            <p className="text-xs text-gray-400 flex items-center gap-1"><ImageIcon className="h-3.5 w-3.5" /> Sem foto</p>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <input id={camId} type="file" accept="image/*" capture="environment" className="hidden"
                  onChange={(e) => { tirarFoto(e.target.files); e.currentTarget.value = ''; }} />
                <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" disabled={saving === 'foto'} asChild>
                  <label htmlFor={camId} className="cursor-pointer">
                    {saving === 'foto' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Camera className="h-4 w-4 mr-1" />}
                    Tirar foto
                  </label>
                </Button>
                <span className="text-[11px] text-gray-400">data e hora automáticas</span>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <input id={upId} type="file" accept="image/*" className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0] || null;
                    if (f && f.size > MAX_FOTO) { toast({ title: 'Foto acima de 10MB', variant: 'destructive' }); return; }
                    setUploadFile(f);
                  }} />
                <Button size="sm" variant="outline" asChild>
                  <label htmlFor={upId} className="cursor-pointer"><Upload className="h-4 w-4 mr-1" /> Anexar foto</label>
                </Button>
                {uploadFile && (
                  <>
                    <span className="text-[11px] text-gray-500 max-w-[140px] truncate" title={uploadFile.name}>{uploadFile.name}</span>
                    <div className="space-y-0.5">
                      <Label className="text-[11px] text-gray-500">Data e hora do evento *</Label>
                      <Input type="datetime-local" value={uploadWhen} onChange={(e) => setUploadWhen(e.target.value)} className="h-9 w-[210px]" />
                    </div>
                    <Button size="sm" onClick={anexarFoto} disabled={saving === 'foto'} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                      {saving === 'foto' && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} Salvar foto
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setUploadFile(null)}>Cancelar</Button>
                  </>
                )}
              </div>
            </div>
          )}
          {item.requiresPhoto && !item.hasPhoto && (
            <p className="text-[11px] text-amber-600 flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> Foto obrigatória neste item.</p>
          )}
        </div>

        <div className="space-y-1">
          <Label className="text-[11px] text-gray-500">Observação</Label>
          <Textarea rows={2} value={notes} disabled={bloqueado}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => { if ((item.notes || '') !== notes) setCampo('notes', notes); }}
            placeholder="Opcional — obrigatória na prática quando algo está não conforme." />
        </div>
      </CardContent>
    </Card>
  );
}

// ===========================================================================
// EXECUÇÃO — tela de preenchimento
// ===========================================================================
function ExecucaoView({ runId, onVoltar }: { runId: string; onVoltar: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['/api/industria/checklist-execucoes', runId],
    queryFn: () => jfetch(`/api/industria/checklist-execucoes/${runId}`),
  });
  const { data: funcData } = useQuery({
    queryKey: ['/api/industria/funcionarios'],
    queryFn: () => jfetch('/api/industria/funcionarios'),
  });
  const run = data?.execucao;
  const funcionarios: any[] = funcData?.funcionarios || [];
  const itens: any[] = run?.itens || [];
  const resumo = run?.resumo || {};
  const bloqueado = run?.status === 'concluida' || run?.status === 'cancelada';

  const atualizar = () => {
    refetch();
    qc.invalidateQueries({ queryKey: ['/api/industria/checklist-execucoes'] });
  };

  const mudarStatus = async (status: string, forcar = false) => {
    try {
      const r = await jfetch(`/api/industria/checklist-execucoes/${runId}`, {
        method: 'PATCH', body: JSON.stringify({ status, forcar: forcar ? '1' : undefined }),
      });
      toast({ title: r?.message || 'Atualizado' });
      atualizar();
    } catch (e: any) {
      const msg = String(e.message || e);
      if (status === 'concluida' && !forcar && msg.toLowerCase().includes('faltam')) {
        if (confirm(`${msg}\n\nConcluir mesmo assim?`)) return mudarStatus('concluida', true);
        return;
      }
      toast({ title: 'Erro', description: msg, variant: 'destructive' });
    }
  };

  const exportar = () => {
    exportToExcel(itens.map((i) => ({
      'Check-list': run.templateName,
      'Data': fmtDate(run.runDate),
      'Turno': run.shift || '',
      '#': i.position + 1,
      'Item': i.title,
      'Responsável': i.employeeName || '',
      'Conformidade': i.conformidade ? CONF_LABEL[i.conformidade] : 'Pendente',
      'Foto': i.hasPhoto ? (i.photoSource === 'camera' ? 'Tirada na hora' : 'Anexada') : 'Sem foto',
      'Data/hora do evento': i.eventAt ? fmtDateTime(i.eventAt) : '',
      'Observação': i.notes || '',
    })), `checklist-${(run?.templateName || 'execucao').toLowerCase().replace(/\s+/g, '-')}-${run?.runDate || ''}`);
  };

  if (isLoading || !run) {
    return <div className="text-center py-10 text-gray-400"><Loader2 className="h-5 w-5 animate-spin inline" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="outline" size="sm" onClick={onVoltar}><ArrowLeft className="h-4 w-4 mr-1" /> Voltar</Button>
        <div>
          <p className="font-semibold">{run.templateName}</p>
          <p className="text-xs text-gray-500">
            {fmtDate(run.runDate)}{run.shift ? ` · ${run.shift}` : ''} · {run.instanceName}
          </p>
        </div>
        <Badge className={RUN_STATUS_CLASS[run.status]}>{RUN_STATUS_LABEL[run.status] || run.status}</Badge>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={exportar}><FileSpreadsheet className="h-4 w-4 mr-1" /> Excel</Button>
        {run.status === 'aberta' ? (
          <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => mudarStatus('concluida')}>
            <Lock className="h-4 w-4 mr-1" /> Concluir check-list
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => mudarStatus('aberta')}>
            <Unlock className="h-4 w-4 mr-1" /> Reabrir
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { n: resumo.total, l: 'Itens', bg: 'bg-emerald-100', fg: 'text-emerald-600', I: ClipboardList },
          { n: resumo.conformes, l: 'Conformes', bg: 'bg-green-100', fg: 'text-green-600', I: CheckCircle2 },
          { n: resumo.naoConformes, l: 'Não conformes', bg: 'bg-red-100', fg: 'text-red-600', I: XCircle },
          { n: resumo.pendentes, l: 'Pendentes', bg: 'bg-amber-100', fg: 'text-amber-600', I: AlertTriangle },
          { n: resumo.comFoto, l: 'Com foto', bg: 'bg-blue-100', fg: 'text-blue-600', I: ImageIcon },
        ].map((k) => (
          <Card key={k.l}><CardContent className="p-3 flex items-center gap-3">
            <div className={`p-2 rounded-lg ${k.bg}`}><k.I className={`h-5 w-5 ${k.fg}`} /></div>
            <div><p className="text-xl font-bold">{k.n ?? 0}</p><p className="text-[11px] text-gray-500">{k.l}</p></div>
          </CardContent></Card>
        ))}
      </div>

      {bloqueado && (
        <p className="text-xs text-gray-500 flex items-center gap-1">
          <Lock className="h-3.5 w-3.5" /> Check-list {RUN_STATUS_LABEL[run.status]?.toLowerCase()} — reabra para editar.
        </p>
      )}

      <div className="space-y-3">
        {itens.map((i) => (
          <ItemExecucao key={i.id} run={run} item={i} funcionarios={funcionarios} onDone={atualizar} bloqueado={bloqueado} />
        ))}
      </div>
    </div>
  );
}

// ===========================================================================
// EXECUÇÕES — lista + abrir nova
// ===========================================================================
function NovaExecucaoDialog({ onClose, onCriada }: { onClose: () => void; onCriada: (id: string) => void }) {
  const { toast } = useToast();
  const [templateId, setTemplateId] = useState('');
  const [runDate, setRunDate] = useState(hojeISO());
  const [shift, setShift] = useState('');
  const [saving, setSaving] = useState(false);
  const { data } = useQuery({
    queryKey: ['/api/industria/checklists'],
    queryFn: () => jfetch('/api/industria/checklists'),
  });
  const modelos: any[] = (data?.checklists || []).filter((m: any) => m.totalItens > 0);

  const abrir = async () => {
    if (!templateId) { toast({ title: 'Selecione o check-list', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      const r = await jfetch('/api/industria/checklist-execucoes', {
        method: 'POST', body: JSON.stringify({ templateId, runDate, shift }),
      });
      toast({ title: 'Check-list aberto' });
      onCriada(r?.execucao?.id);
      onClose();
    } catch (e: any) {
      toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Abrir check-list</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Check-list *</Label>
            <Select value={templateId} onValueChange={setTemplateId}>
              <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
              <SelectContent>
                {modelos.map((m) => <SelectItem key={m.id} value={m.id}>{m.name} ({m.totalItens} itens)</SelectItem>)}
              </SelectContent>
            </Select>
            {!modelos.length && <p className="text-[11px] text-amber-600">Nenhum check-list com itens. Cadastre um em "Modelos".</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Data *</Label>
              <Input type="date" value={runDate} onChange={(e) => setRunDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Turno</Label>
              <Input value={shift} onChange={(e) => setShift(e.target.value)} placeholder="Manhã, tarde…" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={abrir} disabled={saving || !modelos.length} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} Abrir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExecucoesView() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [aberta, setAberta] = useState<string | null>(null);
  const [novo, setNovo] = useState(false);
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const [statusFilter, setStatusFilter] = useState('todos');

  const qs = new URLSearchParams();
  if (de) qs.set('de', de);
  if (ate) qs.set('ate', ate);
  if (statusFilter !== 'todos') qs.set('status', statusFilter);
  const url = `/api/industria/checklist-execucoes${qs.toString() ? `?${qs}` : ''}`;

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['/api/industria/checklist-execucoes', de, ate, statusFilter],
    queryFn: () => jfetch(url),
  });
  const execucoes: any[] = data?.execucoes || [];
  const resumo = data?.resumo || {};
  const atualizar = () => qc.invalidateQueries({ queryKey: ['/api/industria/checklist-execucoes'] });

  const remover = async (e: any) => {
    if (!confirm(`Excluir a execução de "${e.templateName}" de ${fmtDate(e.runDate)}?\nAs fotos registradas serão apagadas.`)) return;
    try {
      await jfetch(`/api/industria/checklist-execucoes/${e.id}`, { method: 'DELETE' });
      toast({ title: 'Execução removida' });
      atualizar();
    } catch (err: any) {
      toast({ title: 'Erro', description: String(err.message || err), variant: 'destructive' });
    }
  };

  const exportar = () => {
    exportToExcel(execucoes.map((e) => ({
      'Check-list': e.templateName, 'Data': fmtDate(e.runDate), 'Turno': e.shift,
      'Status': RUN_STATUS_LABEL[e.status] || e.status,
      'Itens': e.resumo?.total ?? 0, 'Conformes': e.resumo?.conformes ?? 0,
      'Não conformes': e.resumo?.naoConformes ?? 0, 'Pendentes': e.resumo?.pendentes ?? 0,
      'Com foto': e.resumo?.comFoto ?? 0,
    })), `checklists-execucoes-${new Date().toISOString().slice(0, 10)}`);
  };

  if (aberta) return <ExecucaoView runId={aberta} onVoltar={() => { setAberta(null); atualizar(); }} />;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { n: resumo.total, l: 'Execuções', bg: 'bg-emerald-100', fg: 'text-emerald-600', I: ClipboardCheck },
          { n: resumo.hoje, l: 'Hoje', bg: 'bg-blue-100', fg: 'text-blue-600', I: Clock },
          { n: resumo.abertas, l: 'Em preenchimento', bg: 'bg-amber-100', fg: 'text-amber-600', I: Pencil },
          { n: resumo.naoConformes, l: 'Não conformidades', bg: 'bg-red-100', fg: 'text-red-600', I: XCircle },
          { n: resumo.pendentes, l: 'Itens pendentes', bg: 'bg-gray-100', fg: 'text-gray-600', I: AlertTriangle },
        ].map((k) => (
          <Card key={k.l}><CardContent className="p-4 flex items-center gap-3">
            <div className={`p-2 ${k.bg} rounded-lg`}><k.I className={`h-5 w-5 ${k.fg}`} /></div>
            <div><p className="text-2xl font-bold">{k.n ?? 0}</p><p className="text-xs text-gray-500">{k.l}</p></div>
          </CardContent></Card>
        ))}
      </div>

      <div className="flex items-end gap-2 flex-wrap">
        <div className="space-y-1">
          <Label className="text-[11px] text-gray-500">De</Label>
          <Input type="date" value={de} onChange={(e) => setDe(e.target.value)} className="w-[150px]" />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-gray-500">Até</Label>
          <Input type="date" value={ate} onChange={(e) => setAte(e.target.value)} className="w-[150px]" />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos os status</SelectItem>
            <SelectItem value="aberta">Em preenchimento</SelectItem>
            <SelectItem value="concluida">Concluído</SelectItem>
            <SelectItem value="cancelada">Cancelado</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={exportar} disabled={!execucoes.length}>
          <FileSpreadsheet className="h-4 w-4 mr-1" /> Excel
        </Button>
        <Button size="sm" onClick={() => setNovo(true)} className="bg-emerald-600 hover:bg-emerald-700 text-white">
          <Plus className="h-4 w-4 mr-1" /> Abrir check-list
        </Button>
      </div>

      <div className="border rounded-lg overflow-auto max-h-[60vh]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Data</TableHead>
              <TableHead>Check-list</TableHead>
              <TableHead>Turno</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Progresso</TableHead>
              <TableHead>Fotos</TableHead>
              <TableHead className="w-[110px] text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={7} className="text-center py-8 text-gray-400"><Loader2 className="h-5 w-5 animate-spin inline" /></TableCell></TableRow>
            ) : !execucoes.length ? (
              <TableRow><TableCell colSpan={7} className="text-center py-8 text-gray-400">
                Nenhuma execução no período. Clique em "Abrir check-list".
              </TableCell></TableRow>
            ) : execucoes.map((e) => (
              <TableRow key={e.id} className={e.resumo?.naoConformes ? 'bg-red-50/40' : ''}>
                <TableCell>{fmtDate(e.runDate)}</TableCell>
                <TableCell className="font-medium">{e.templateName}</TableCell>
                <TableCell>{e.shift || '-'}</TableCell>
                <TableCell><Badge className={RUN_STATUS_CLASS[e.status]}>{RUN_STATUS_LABEL[e.status] || e.status}</Badge></TableCell>
                <TableCell className="text-sm">
                  <span className="text-green-700">{e.resumo?.conformes ?? 0} ok</span>
                  {(e.resumo?.naoConformes ?? 0) > 0 && <span className="text-red-600"> · {e.resumo.naoConformes} NC</span>}
                  {(e.resumo?.pendentes ?? 0) > 0 && <span className="text-amber-600"> · {e.resumo.pendentes} pend.</span>}
                  <span className="text-gray-400"> / {e.resumo?.total ?? 0}</span>
                </TableCell>
                <TableCell className="text-sm">
                  {e.resumo?.comFoto ?? 0}
                  {(e.resumo?.fotosPendentes ?? 0) > 0 && <span className="text-amber-600"> ({e.resumo.fotosPendentes} faltando)</span>}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => setAberta(e.id)} title="Abrir"><Eye className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-600" onClick={() => remover(e)} title="Excluir"><Trash2 className="h-4 w-4" /></Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {novo && <NovaExecucaoDialog onClose={() => setNovo(false)} onCriada={(id) => { atualizar(); if (id) setAberta(id); }} />}
    </div>
  );
}

// ===========================================================================
// aba
// ===========================================================================
export default function ChecklistIndustria() {
  return (
    <Tabs defaultValue="execucoes" className="space-y-4">
      <TabsList>
        <TabsTrigger value="execucoes" className="flex items-center gap-1.5">
          <ClipboardCheck className="h-4 w-4" /> Preenchimento
        </TabsTrigger>
        <TabsTrigger value="modelos" className="flex items-center gap-1.5">
          <ClipboardList className="h-4 w-4" /> Modelos de check-list
        </TabsTrigger>
      </TabsList>
      <TabsContent value="execucoes"><ExecucoesView /></TabsContent>
      <TabsContent value="modelos"><ModelosView /></TabsContent>
    </Tabs>
  );
}
