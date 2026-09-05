// MANUTENÇÃO DE MÁQUINAS (módulo Indústria › aba Manutenção) — 05/set/2026
// Máquinas da fábrica com manutenções preventivas/corretivas, observações
// técnicas e fotos (das partes e das manutenções), carimbadas com data/hora/
// usuário. Backend: server/fabrica-routes.ts (/api/industria/maquinas*).
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
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { carimbarFoto, agoraBR } from '@/lib/fotoCarimbo';
import { Plus, Pencil, Trash2, RefreshCw, Wrench, Camera, Loader2, Search, AlertTriangle, CalendarClock, ImageIcon, StickyNote, ChevronLeft } from 'lucide-react';

const jfetch = async (url: string, opts: any = {}) => {
  const r = await fetch(url, { credentials: 'include', headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(j?.error || j?.message || `Falha (${r.status})`);
  return j;
};
const hojeISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const fmtData = (v: any) => { if (!v) return '-'; const [y, m, d] = String(v).slice(0, 10).split('-'); return d ? `${d}/${m}/${y}` : String(v); };
const fmtHora = (v: any) => v ? new Date(v).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
const fmtBRL = (v: any) => v == null ? '-' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const diasAte = (iso: string | null) => { if (!iso) return null; return Math.round((new Date(iso + 'T00:00:00Z').getTime() - new Date(hojeISO() + 'T00:00:00Z').getTime()) / 86400000); };

const STATUS_MAQ: Record<string, { label: string; cls: string }> = {
  ativa: { label: 'Ativa', cls: 'bg-emerald-100 text-emerald-700' },
  parada: { label: 'Parada', cls: 'bg-red-100 text-red-700' },
  manutencao: { label: 'Em manutenção', cls: 'bg-amber-100 text-amber-700' },
  desativada: { label: 'Desativada', cls: 'bg-gray-100 text-gray-600' },
};
const TIPO_MAN: Record<string, { label: string; cls: string }> = {
  preventiva: { label: 'Preventiva', cls: 'bg-blue-100 text-blue-700' },
  corretiva: { label: 'Corretiva', cls: 'bg-red-100 text-red-700' },
  preditiva: { label: 'Preditiva', cls: 'bg-purple-100 text-purple-700' },
  inspecao: { label: 'Inspeção', cls: 'bg-slate-100 text-slate-700' },
};
const STATUS_MAN: Record<string, { label: string; cls: string }> = {
  agendada: { label: 'Agendada', cls: 'bg-amber-100 text-amber-700' },
  em_andamento: { label: 'Em andamento', cls: 'bg-blue-100 text-blue-700' },
  realizada: { label: 'Realizada', cls: 'bg-emerald-100 text-emerald-700' },
  cancelada: { label: 'Cancelada', cls: 'bg-gray-100 text-gray-600' },
};

export default function ManutencaoMaquinas() {
  const [aberta, setAberta] = useState<string | null>(null);
  return aberta ? <MaquinaDetalhe id={aberta} onBack={() => setAberta(null)} /> : <MaquinasLista onOpen={setAberta} />;
}

// ============================ LISTA ============================
function MaquinasLista({ onOpen }: { onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<any>(null); // {} novo, maquina p/ editar
  const { data, isLoading, refetch, isFetching } = useQuery({ queryKey: ['/api/industria/maquinas'], queryFn: () => jfetch('/api/industria/maquinas') });
  const maquinas: any[] = data?.maquinas || [];
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return s ? maquinas.filter((m) => [m.name, m.code, m.sector, m.brand, m.model].some((v) => String(v || '').toLowerCase().includes(s))) : maquinas;
  }, [maquinas, search]);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['/api/industria/maquinas'] });
  const proximaDe = (m: any) => m.proximaAgendada || m.proximaPreventivaSugerida || null;
  const atrasadas = maquinas.filter((m) => { const d = diasAte(proximaDe(m)); return d != null && d < 0 && m.status !== 'desativada'; }).length;
  const emBreve = maquinas.filter((m) => { const d = diasAte(proximaDe(m)); return d != null && d >= 0 && d <= 15 && m.status !== 'desativada'; }).length;

  const remover = async (m: any) => {
    if (!window.confirm(`Excluir a máquina "${m.name}"? Manutenções, observações e fotos vão junto. Não dá para desfazer.`)) return;
    try { await jfetch(`/api/industria/maquinas/${m.id}`, { method: 'DELETE' }); toast({ title: 'Máquina excluída' }); invalidate(); }
    catch (e: any) { toast({ title: 'Erro ao excluir', description: String(e.message || e), variant: 'destructive' }); }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><CardContent className="p-4 flex items-center gap-3"><div className="p-2 bg-emerald-100 rounded-lg"><Wrench className="h-5 w-5 text-emerald-600" /></div><div><p className="text-2xl font-bold">{maquinas.length}</p><p className="text-xs text-gray-500">Máquinas</p></div></CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3"><div className="p-2 bg-amber-100 rounded-lg"><CalendarClock className="h-5 w-5 text-amber-600" /></div><div><p className="text-2xl font-bold">{emBreve}</p><p className="text-xs text-gray-500">Manutenção nos próximos 15 dias</p></div></CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3"><div className="p-2 bg-red-100 rounded-lg"><AlertTriangle className="h-5 w-5 text-red-600" /></div><div><p className="text-2xl font-bold">{atrasadas}</p><p className="text-xs text-gray-500">Manutenção atrasada</p></div></CardContent></Card>
        <Card><CardContent className="p-4 flex items-center gap-3"><div className="p-2 bg-gray-100 rounded-lg"><AlertTriangle className="h-5 w-5 text-gray-600" /></div><div><p className="text-2xl font-bold">{maquinas.filter((m) => m.status === 'parada' || m.status === 'manutencao').length}</p><p className="text-xs text-gray-500">Paradas / em manutenção</p></div></CardContent></Card>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" /><Input placeholder="Buscar máquina, setor, marca..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 w-[260px]" /></div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}><RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} /></Button>
        <span className="text-sm text-gray-500">{isLoading ? 'Carregando...' : `${filtered.length} máquina(s)`}</span>
        <div className="flex-1" />
        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => setDialog({})}><Plus className="h-4 w-4 mr-1" /> Nova Máquina</Button>
      </div>
      <div className="border rounded-lg overflow-auto max-h-[60vh]">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Máquina</TableHead><TableHead>Setor</TableHead><TableHead>Marca / Modelo</TableHead><TableHead>Status</TableHead>
            <TableHead>Última preventiva</TableHead><TableHead>Última corretiva</TableHead><TableHead>Próxima</TableHead><TableHead className="text-center">Hist.</TableHead><TableHead className="text-right">Ações</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {filtered.map((m) => {
              const st = STATUS_MAQ[m.status] || STATUS_MAQ.ativa;
              const prox = proximaDe(m); const d = diasAte(prox);
              return (
                <TableRow key={m.id} className="cursor-pointer hover:bg-gray-50" onClick={() => onOpen(m.id)}>
                  <TableCell><div className="font-medium">{m.name}</div>{m.code && <div className="text-xs text-gray-400 font-mono">{m.code}</div>}</TableCell>
                  <TableCell>{m.sector || '-'}</TableCell>
                  <TableCell className="text-sm">{[m.brand, m.model].filter(Boolean).join(' / ') || '-'}</TableCell>
                  <TableCell><Badge className={`${st.cls} hover:${st.cls}`}>{st.label}</Badge></TableCell>
                  <TableCell>{fmtData(m.ultimaPreventiva)}</TableCell>
                  <TableCell>{fmtData(m.ultimaCorretiva)}</TableCell>
                  <TableCell>
                    {prox ? (
                      <span className={d != null && d < 0 ? 'text-red-600 font-semibold' : d != null && d <= 15 ? 'text-amber-700 font-medium' : ''}>
                        {fmtData(prox)}{d != null && <span className="text-[10px] ml-1">({d < 0 ? `${-d}d atrás` : d === 0 ? 'hoje' : `em ${d}d`})</span>}
                        {!m.proximaAgendada && <span className="block text-[10px] text-gray-400">sugerida pelo intervalo</span>}
                      </span>
                    ) : <span className="text-gray-400">-</span>}
                  </TableCell>
                  <TableCell className="text-center text-xs text-gray-500"><span title="manutenções"><Wrench className="inline h-3 w-3" /> {m.manutencoes}</span> · <span title="fotos"><ImageIcon className="inline h-3 w-3" /> {m.fotos}</span> · <span title="observações"><StickyNote className="inline h-3 w-3" /> {m.observacoes}</span></TableCell>
                  <TableCell className="text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    <Button variant="ghost" size="sm" title="Editar" onClick={() => setDialog(m)}><Pencil className="h-4 w-4 text-blue-500" /></Button>
                    <Button variant="ghost" size="sm" title="Excluir" className="text-red-500" onClick={() => remover(m)}><Trash2 className="h-4 w-4" /></Button>
                  </TableCell>
                </TableRow>
              );
            })}
            {!isLoading && filtered.length === 0 && <TableRow><TableCell colSpan={9} className="text-center text-gray-400 py-8">Nenhuma máquina cadastrada</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>
      {dialog != null && <MaquinaDialog maquina={dialog} onClose={() => setDialog(null)} onDone={() => { setDialog(null); invalidate(); }} />}
    </div>
  );
}

function MaquinaDialog({ maquina, onClose, onDone }: any) {
  const { toast } = useToast();
  const isNew = !maquina.id;
  const [f, setF] = useState<any>({
    name: maquina.name || '', code: maquina.code || '', sector: maquina.sector || '', brand: maquina.brand || '', model: maquina.model || '',
    serialNumber: maquina.serialNumber || '', manufactureYear: maquina.manufactureYear ?? '', acquisitionDate: maquina.acquisitionDate || '',
    status: maquina.status || 'ativa', preventiveIntervalDays: maquina.preventiveIntervalDays ?? '', technicalData: maquina.technicalData || '', notes: maquina.notes || '',
  });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!f.name.trim()) { toast({ title: 'Informe o nome da máquina', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      if (isNew) await jfetch('/api/industria/maquinas', { method: 'POST', body: JSON.stringify(f) });
      else await jfetch(`/api/industria/maquinas/${maquina.id}`, { method: 'PATCH', body: JSON.stringify(f) });
      toast({ title: isNew ? 'Máquina cadastrada' : 'Máquina atualizada' }); onDone();
    } catch (e: any) { toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' }); }
    finally { setSaving(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{isNew ? 'Nova Máquina' : `Editar ${maquina.name}`}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-2 space-y-1.5"><Label>Nome *</Label><Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Ex.: Envasadora linha 1" /></div>
            <div className="space-y-1.5"><Label>Código / TAG</Label><Input value={f.code} onChange={(e) => set('code', e.target.value)} placeholder="ENV-01" /></div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="space-y-1.5"><Label>Setor</Label><Input value={f.sector} onChange={(e) => set('sector', e.target.value)} placeholder="Envase" /></div>
            <div className="space-y-1.5"><Label>Marca</Label><Input value={f.brand} onChange={(e) => set('brand', e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Modelo</Label><Input value={f.model} onChange={(e) => set('model', e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Nº de série</Label><Input value={f.serialNumber} onChange={(e) => set('serialNumber', e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="space-y-1.5"><Label>Ano fabricação</Label><Input inputMode="numeric" value={f.manufactureYear} onChange={(e) => set('manufactureYear', e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Aquisição</Label><Input type="date" value={f.acquisitionDate} onChange={(e) => set('acquisitionDate', e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Status</Label>
              <Select value={f.status} onValueChange={(v) => set('status', v)}><SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(STATUS_MAQ).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}</SelectContent></Select>
            </div>
            <div className="space-y-1.5"><Label>Preventiva a cada (dias)</Label><Input inputMode="numeric" value={f.preventiveIntervalDays} onChange={(e) => set('preventiveIntervalDays', e.target.value)} placeholder="Ex.: 90" /></div>
          </div>
          <div className="space-y-1.5"><Label>Dados técnicos</Label><Textarea rows={4} value={f.technicalData} onChange={(e) => set('technicalData', e.target.value)} placeholder="Potência, tensão, capacidade, lubrificantes, peças de reposição, fornecedor de assistência..." /></div>
          <div className="space-y-1.5"><Label>Observações gerais</Label><Textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={save} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700 text-white">{saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}{isNew ? 'Cadastrar' : 'Salvar'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================ DETALHE ============================
function MaquinaDetalhe({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth() as any;
  const nomeUsuario = user ? ([user.firstName, user.lastName].filter(Boolean).join(' ') || user.email) : '';
  const { data, isLoading } = useQuery({ queryKey: ['/api/industria/maquinas', id], queryFn: () => jfetch(`/api/industria/maquinas/${id}`) });
  const m = data?.maquina;
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['/api/industria/maquinas', id] }); qc.invalidateQueries({ queryKey: ['/api/industria/maquinas'] }); };
  const [editar, setEditar] = useState(false);
  const [manDialog, setManDialog] = useState<any>(null);
  const [obs, setObs] = useState({ title: '', content: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [fotoAberta, setFotoAberta] = useState<any>(null);
  const [legenda, setLegenda] = useState('');
  const fotoRef = useRef<HTMLInputElement | null>(null);
  const [fotoManutId, setFotoManutId] = useState<string | null>(null);

  const addObs = async () => {
    if (!obs.content.trim()) return;
    setBusy('obs');
    try { await jfetch(`/api/industria/maquinas/${id}/observacoes`, { method: 'POST', body: JSON.stringify(obs) }); setObs({ title: '', content: '' }); invalidate(); }
    catch (e: any) { toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' }); }
    finally { setBusy(null); }
  };
  const delObs = async (o: any) => {
    if (!window.confirm('Remover esta observação?')) return;
    try { await jfetch(`/api/industria/maquinas/observacoes/${o.id}`, { method: 'DELETE' }); invalidate(); } catch (e: any) { toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' }); }
  };
  const delMan = async (x: any) => {
    if (!window.confirm(`Excluir a manutenção ${TIPO_MAN[x.type]?.label || x.type} de ${fmtData(x.doneDate || x.scheduledDate)}?`)) return;
    try { await jfetch(`/api/industria/maquinas/manutencoes/${x.id}`, { method: 'DELETE' }); invalidate(); } catch (e: any) { toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' }); }
  };
  const concluirMan = async (x: any) => {
    try { await jfetch(`/api/industria/maquinas/manutencoes/${x.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'realizada', doneDate: hojeISO() }) }); toast({ title: 'Manutenção marcada como realizada' }); invalidate(); }
    catch (e: any) { toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' }); }
  };
  const pedirFoto = (manutId: string | null) => { setFotoManutId(manutId); fotoRef.current?.click(); };
  const enviarFoto = async (file: File | undefined) => {
    if (!file || !m) return;
    setBusy('foto');
    try {
      const man = fotoManutId ? (data?.manutencoes || []).find((x: any) => x.id === fotoManutId) : null;
      const rotulo = man ? `${m.name} — ${TIPO_MAN[man.type]?.label || man.type} ${fmtData(man.doneDate || man.scheduledDate)}` : `${m.name}${legenda ? ' — ' + legenda : ''}`;
      const blob = await carimbarFoto(file, [`${agoraBR()}  •  ${nomeUsuario}`, rotulo.slice(0, 90)]);
      const fd = new FormData();
      fd.append('arquivo', blob, `maquina_${(m.code || m.name).replace(/\W+/g, '_')}_${Date.now()}.jpg`);
      if (fotoManutId) fd.append('maintenanceId', fotoManutId);
      if (legenda.trim()) fd.append('caption', legenda.trim());
      await jfetch(`/api/industria/maquinas/${id}/fotos`, { method: 'POST', body: fd });
      setLegenda(''); setFotoManutId(null); toast({ title: 'Foto anexada', description: agoraBR() }); invalidate();
    } catch (e: any) { toast({ title: 'Erro ao anexar foto', description: String(e.message || e), variant: 'destructive' }); }
    finally { setBusy(null); }
  };
  const delFoto = async (f: any) => {
    if (!window.confirm('Remover esta foto?')) return;
    try { await jfetch(`/api/industria/maquinas/fotos/${f.id}`, { method: 'DELETE' }); setFotoAberta(null); invalidate(); } catch (e: any) { toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' }); }
  };

  if (isLoading || !m) return <div className="space-y-3"><Button variant="outline" size="sm" onClick={onBack}><ChevronLeft className="h-4 w-4 mr-1" /> Máquinas</Button><p className="text-sm text-gray-400">{isLoading ? 'Carregando...' : 'Máquina não encontrada'}</p></div>;
  const st = STATUS_MAQ[m.status] || STATUS_MAQ.ativa;
  const manutencoes: any[] = data?.manutencoes || [];
  const fotos: any[] = data?.fotos || [];
  const observacoes: any[] = data?.observacoes || [];
  const fotosDaManut = (mid: string) => fotos.filter((f) => f.maintenanceId === mid);
  const fotosGerais = fotos.filter((f) => !f.maintenanceId);

  const Foto = ({ f }: { f: any }) => (
    <button type="button" onClick={() => setFotoAberta(f)} className="text-left" title={`${fmtHora(f.takenAt)}${f.createdBy ? ' · ' + f.createdBy : ''}`}>
      <img src={`/api/industria/maquinas/fotos/${f.id}/arquivo`} alt={f.caption || 'foto'} className="h-24 w-32 object-cover rounded border" loading="lazy" />
      {f.caption && <div className="text-[10px] text-gray-600 w-32 truncate">{f.caption}</div>}
      <div className="text-[10px] text-gray-400">{fmtHora(f.takenAt)}</div>
    </button>
  );

  return (
    <div className="space-y-4">
      <input type="file" accept="image/*" capture="environment" className="hidden" ref={fotoRef} onChange={(e) => { enviarFoto(e.target.files?.[0]); e.target.value = ''; }} />
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="outline" size="sm" onClick={onBack}><ChevronLeft className="h-4 w-4 mr-1" /> Máquinas</Button>
        <h2 className="text-lg font-bold">{m.name}</h2>
        {m.code && <span className="font-mono text-xs text-gray-500">{m.code}</span>}
        <Badge className={`${st.cls} hover:${st.cls}`}>{st.label}</Badge>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => setEditar(true)}><Pencil className="h-4 w-4 mr-1" /> Editar cadastro</Button>
        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => setManDialog({})}><Wrench className="h-4 w-4 mr-1" /> Nova manutenção</Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-1"><CardContent className="p-4 space-y-2 text-sm">
          <div className="font-semibold">Ficha</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <span className="text-gray-500">Setor</span><span>{m.sector || '-'}</span>
            <span className="text-gray-500">Marca / Modelo</span><span>{[m.brand, m.model].filter(Boolean).join(' / ') || '-'}</span>
            <span className="text-gray-500">Nº de série</span><span>{m.serialNumber || '-'}</span>
            <span className="text-gray-500">Ano / Aquisição</span><span>{m.manufactureYear || '-'} / {fmtData(m.acquisitionDate)}</span>
            <span className="text-gray-500">Preventiva a cada</span><span>{m.preventiveIntervalDays ? `${m.preventiveIntervalDays} dias` : '-'}</span>
            <span className="text-gray-500">Última preventiva</span><span>{fmtData(m.ultimaPreventiva)}</span>
            <span className="text-gray-500">Última corretiva</span><span>{fmtData(m.ultimaCorretiva)}</span>
            <span className="text-gray-500">Próxima</span><span>{fmtData(m.proximaAgendada || m.proximaPreventivaSugerida)}{!m.proximaAgendada && m.proximaPreventivaSugerida ? ' (sugerida)' : ''}</span>
          </div>
          {m.technicalData && <div className="pt-2"><div className="text-xs text-gray-500">Dados técnicos</div><pre className="text-xs whitespace-pre-wrap font-sans bg-gray-50 rounded p-2">{m.technicalData}</pre></div>}
          {m.notes && <div><div className="text-xs text-gray-500">Observações gerais</div><p className="text-xs whitespace-pre-wrap">{m.notes}</p></div>}
        </CardContent></Card>

        <Card className="lg:col-span-2"><CardContent className="p-4 space-y-3">
          <div className="font-semibold text-sm flex items-center gap-2"><Wrench className="h-4 w-4" /> Manutenções ({manutencoes.length})</div>
          {manutencoes.length === 0 && <p className="text-xs text-gray-400">Nenhuma manutenção registrada.</p>}
          <div className="space-y-2">
            {manutencoes.map((x) => {
              const tp = TIPO_MAN[x.type] || TIPO_MAN.preventiva; const sm = STATUS_MAN[x.status] || STATUS_MAN.agendada;
              const d = x.status !== 'realizada' && x.status !== 'cancelada' ? diasAte(x.scheduledDate) : null;
              const fm = fotosDaManut(x.id);
              return (
                <div key={x.id} className={`rounded-lg border p-3 text-sm ${d != null && d < 0 ? 'border-red-300 bg-red-50/40' : ''}`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge className={`${tp.cls} hover:${tp.cls}`}>{tp.label}</Badge>
                    <Badge className={`${sm.cls} hover:${sm.cls}`}>{sm.label}</Badge>
                    <span className="text-xs text-gray-600">{x.doneDate ? `Realizada ${fmtData(x.doneDate)}` : `Agendada ${fmtData(x.scheduledDate)}`}{d != null && <b className={d < 0 ? 'text-red-600' : ''}> ({d < 0 ? `${-d}d atrasada` : d === 0 ? 'hoje' : `em ${d}d`})</b>}</span>
                    {x.performedBy && <span className="text-xs text-gray-500">· {x.performedBy}</span>}
                    {x.cost != null && <span className="text-xs text-gray-500">· {fmtBRL(x.cost)}</span>}
                    {x.downtimeHours != null && <span className="text-xs text-gray-500">· {x.downtimeHours}h parada</span>}
                    <div className="flex-1" />
                    {x.status !== 'realizada' && x.status !== 'cancelada' && <Button size="sm" variant="outline" onClick={() => concluirMan(x)}>Concluir hoje</Button>}
                    <Button size="sm" variant="ghost" onClick={() => pedirFoto(x.id)} disabled={busy === 'foto'} title="Foto desta manutenção"><Camera className="h-4 w-4" /></Button>
                    <Button size="sm" variant="ghost" onClick={() => setManDialog(x)}><Pencil className="h-4 w-4 text-blue-500" /></Button>
                    <Button size="sm" variant="ghost" className="text-red-500" onClick={() => delMan(x)}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                  {x.description && <p className="text-xs mt-1 whitespace-pre-wrap">{x.description}</p>}
                  {x.notes && <p className="text-xs mt-1 text-gray-500 whitespace-pre-wrap">{x.notes}</p>}
                  {fm.length > 0 && <div className="flex gap-2 flex-wrap mt-2">{fm.map((f) => <Foto key={f.id} f={f} />)}</div>}
                  <div className="text-[10px] text-gray-400 mt-1">Registrado {fmtHora(x.createdAt)}{x.createdBy ? ` por ${x.createdBy}` : ''}</div>
                </div>
              );
            })}
          </div>
        </CardContent></Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card><CardContent className="p-4 space-y-3">
          <div className="font-semibold text-sm flex items-center gap-2"><StickyNote className="h-4 w-4" /> Observações / dados técnicos ({observacoes.length})</div>
          <div className="space-y-2">
            <Input value={obs.title} onChange={(e) => setObs((p) => ({ ...p, title: e.target.value }))} placeholder="Título (opcional): ex. Troca de correia, Parâmetros do inversor" className="text-sm" />
            <div className="flex gap-2 items-start">
              <Textarea rows={2} value={obs.content} onChange={(e) => setObs((p) => ({ ...p, content: e.target.value }))} placeholder="Observação técnica..." className="text-sm" />
              <Button onClick={addObs} disabled={!obs.content.trim() || busy === 'obs'} className="bg-emerald-600 hover:bg-emerald-700 text-white h-auto self-stretch">{busy === 'obs' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}</Button>
            </div>
          </div>
          {observacoes.map((o) => (
            <div key={o.id} className="rounded border p-2 text-xs">
              <div className="flex items-center gap-2">{o.title && <b>{o.title}</b>}<span className="text-gray-400">{fmtHora(o.createdAt)}{o.createdBy ? ` · ${o.createdBy}` : ''}</span><div className="flex-1" /><Button size="sm" variant="ghost" className="text-red-500 h-6" onClick={() => delObs(o)}><Trash2 className="h-3 w-3" /></Button></div>
              <p className="whitespace-pre-wrap mt-1">{o.content}</p>
            </div>
          ))}
        </CardContent></Card>

        <Card><CardContent className="p-4 space-y-3">
          <div className="font-semibold text-sm flex items-center gap-2"><ImageIcon className="h-4 w-4" /> Fotos da máquina ({fotosGerais.length})</div>
          <div className="flex gap-2">
            <Input value={legenda} onChange={(e) => setLegenda(e.target.value)} placeholder="Legenda (ex.: painel elétrico, bico dosador)" className="text-sm" />
            <Button variant="outline" onClick={() => pedirFoto(null)} disabled={busy === 'foto'}>{busy === 'foto' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Camera className="h-4 w-4 mr-1" />} Foto</Button>
          </div>
          {fotosGerais.length === 0 && <p className="text-xs text-gray-400">Nenhuma foto. Fotos das manutenções ficam junto de cada manutenção.</p>}
          <div className="flex gap-2 flex-wrap">{fotosGerais.map((f) => <Foto key={f.id} f={f} />)}</div>
        </CardContent></Card>
      </div>

      {editar && <MaquinaDialog maquina={m} onClose={() => setEditar(false)} onDone={() => { setEditar(false); invalidate(); }} />}
      {manDialog != null && <ManutencaoDialog maquinaId={id} manutencao={manDialog} onClose={() => setManDialog(null)} onDone={() => { setManDialog(null); invalidate(); }} />}
      {fotoAberta && (
        <Dialog open onOpenChange={(v) => { if (!v) setFotoAberta(null); }}>
          <DialogContent className="max-w-3xl">
            <DialogHeader><DialogTitle>{fotoAberta.caption || m.name}</DialogTitle></DialogHeader>
            <img src={`/api/industria/maquinas/fotos/${fotoAberta.id}/arquivo`} alt="foto" className="max-h-[70vh] w-auto mx-auto rounded" />
            <div className="flex items-center justify-between text-xs text-gray-500">
              <span>{fmtHora(fotoAberta.takenAt)}{fotoAberta.createdBy ? ` por ${fotoAberta.createdBy}` : ''}</span>
              <div className="flex gap-2">
                <a href={`/api/industria/maquinas/fotos/${fotoAberta.id}/arquivo`} target="_blank" rel="noreferrer"><Button size="sm" variant="outline">Abrir</Button></a>
                <Button size="sm" variant="ghost" className="text-red-500" onClick={() => delFoto(fotoAberta)}><Trash2 className="h-4 w-4 mr-1" /> Remover</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function ManutencaoDialog({ maquinaId, manutencao, onClose, onDone }: any) {
  const { toast } = useToast();
  const isNew = !manutencao.id;
  const [f, setF] = useState<any>({
    type: manutencao.type || 'preventiva', status: manutencao.status || 'agendada',
    scheduledDate: manutencao.scheduledDate || hojeISO(), doneDate: manutencao.doneDate || '',
    description: manutencao.description || '', performedBy: manutencao.performedBy || '', cost: manutencao.cost ?? '', downtimeHours: manutencao.downtimeHours ?? '', notes: manutencao.notes || '',
  });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!f.scheduledDate && !f.doneDate) { toast({ title: 'Informe a data', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      const body = { ...f, doneDate: f.status === 'realizada' ? (f.doneDate || hojeISO()) : f.doneDate };
      if (isNew) await jfetch(`/api/industria/maquinas/${maquinaId}/manutencoes`, { method: 'POST', body: JSON.stringify(body) });
      else await jfetch(`/api/industria/maquinas/manutencoes/${manutencao.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      toast({ title: isNew ? 'Manutenção registrada' : 'Manutenção atualizada' }); onDone();
    } catch (e: any) { toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' }); }
    finally { setSaving(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{isNew ? 'Nova manutenção' : 'Editar manutenção'}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>Tipo</Label><Select value={f.type} onValueChange={(v) => set('type', v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(TIPO_MAN).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-1.5"><Label>Status</Label><Select value={f.status} onValueChange={(v) => set('status', v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(STATUS_MAN).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-1.5"><Label>Data agendada</Label><Input type="date" value={f.scheduledDate} onChange={(e) => set('scheduledDate', e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Data realizada</Label><Input type="date" value={f.doneDate} onChange={(e) => set('doneDate', e.target.value)} /></div>
          </div>
          <div className="space-y-1.5"><Label>Descrição do serviço</Label><Textarea rows={3} value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="O que foi feito / o que precisa ser feito, peças trocadas..." /></div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5"><Label>Executor</Label><Input value={f.performedBy} onChange={(e) => set('performedBy', e.target.value)} placeholder="Técnico / empresa" /></div>
            <div className="space-y-1.5"><Label>Custo (R$)</Label><Input inputMode="decimal" value={f.cost} onChange={(e) => set('cost', e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Horas parada</Label><Input inputMode="decimal" value={f.downtimeHours} onChange={(e) => set('downtimeHours', e.target.value)} /></div>
          </div>
          <div className="space-y-1.5"><Label>Observações</Label><Textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
          <p className="text-xs text-gray-400">Fotos da manutenção: salve e use o ícone de câmera na linha da manutenção.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={save} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700 text-white">{saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Salvar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
