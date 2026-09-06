// CHECKLIST DE PRODUÇÃO (módulo Indústria › aba Checklist) — 05/set/2026
// Um checklist por dia de produção. Itens a verificar são criados por dia;
// cada verificação grava hora e usuário; foto opcional carimbada com
// data/hora/usuário (canvas) e datada de novo no servidor.
// Backend: server/fabrica-routes.ts (/api/industria/checklist*).
import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { carimbarFoto, agoraBR } from '@/lib/fotoCarimbo';
import {
  CheckCircle2, XCircle, Circle, MinusCircle, Camera, Trash2, Plus, Copy, RefreshCw, ChevronLeft, ChevronRight, Loader2, ImageIcon, CalendarDays, Paperclip, FileText, Download,
} from 'lucide-react';

const jfetch = async (url: string, opts: any = {}) => {
  const r = await fetch(url, { credentials: 'include', headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(j?.error || j?.message || `Falha (${r.status})`);
  return j;
};
const hojeISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const fmtData = (iso: string) => { const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
const fmtHora = (v: any) => v ? new Date(v).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
const somaDias = (iso: string, n: number) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmtBytes = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
const diaSemana = (iso: string) => new Date(iso + 'T12:00:00Z').toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'UTC' });

const STATUS: Record<string, { label: string; cls: string; icon: any }> = {
  pendente: { label: 'Pendente', cls: 'bg-gray-100 text-gray-700', icon: Circle },
  ok: { label: 'Conforme', cls: 'bg-emerald-100 text-emerald-700', icon: CheckCircle2 },
  nao_conforme: { label: 'Não conforme', cls: 'bg-red-100 text-red-700', icon: XCircle },
  nao_aplicavel: { label: 'N/A', cls: 'bg-slate-100 text-slate-600', icon: MinusCircle },
};

export default function ChecklistProducao() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth() as any;
  const nomeUsuario = user ? ([user.firstName, user.lastName].filter(Boolean).join(' ') || user.email) : '';
  const [data, setData] = useState(hojeISO());
  const [novo, setNovo] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [fotoAberta, setFotoAberta] = useState<any>(null);
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const arqRefs = useRef<Record<string, HTMLInputElement | null>>({}); // anexos de qualquer tipo

  const dias = useQuery({ queryKey: ['/api/industria/checklist/dias'], queryFn: () => jfetch('/api/industria/checklist/dias') });
  const ck = useQuery({ queryKey: ['/api/industria/checklist', data], queryFn: () => jfetch(`/api/industria/checklist/${data}`) });
  const items: any[] = ck.data?.items || [];
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['/api/industria/checklist', data] }); qc.invalidateQueries({ queryKey: ['/api/industria/checklist/dias'] }); };

  const resumo = useMemo(() => ({
    total: items.length,
    ok: items.filter((i) => i.status === 'ok').length,
    nc: items.filter((i) => i.status === 'nao_conforme').length,
    pend: items.filter((i) => i.status === 'pendente').length,
    fotos: items.filter((i) => i.hasPhoto).length,
  }), [items]);

  const addItem = async () => {
    const descs = novo.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!descs.length) return;
    setBusy('add');
    try {
      await jfetch(`/api/industria/checklist/${data}/itens`, { method: 'POST', body: JSON.stringify({ descriptions: descs }) });
      setNovo(''); invalidate();
    } catch (e: any) { toast({ title: 'Erro ao adicionar', description: String(e.message || e), variant: 'destructive' }); }
    finally { setBusy(null); }
  };
  const copiarAnterior = async () => {
    setBusy('copiar');
    try {
      const j = await jfetch(`/api/industria/checklist/${data}/copiar-anterior`, { method: 'POST' });
      toast({ title: `${j.copiados} item(ns) copiado(s)`, description: `do checklist de ${fmtData(j.de)}` }); invalidate();
    } catch (e: any) { toast({ title: 'Nada copiado', description: String(e.message || e), variant: 'destructive' }); }
    finally { setBusy(null); }
  };
  const setStatus = async (it: any, status: string) => {
    setBusy(it.id);
    try { await jfetch(`/api/industria/checklist/itens/${it.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); invalidate(); }
    catch (e: any) { toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' }); }
    finally { setBusy(null); }
  };
  const salvarNota = async (it: any, notes: string) => {
    if ((it.notes || '') === notes) return;
    try { await jfetch(`/api/industria/checklist/itens/${it.id}`, { method: 'PATCH', body: JSON.stringify({ notes }) }); invalidate(); }
    catch (e: any) { toast({ title: 'Erro ao salvar observação', description: String(e.message || e), variant: 'destructive' }); }
  };
  const removerItem = async (it: any) => {
    if (!window.confirm(`Remover o item "${it.description}"?`)) return;
    try { await jfetch(`/api/industria/checklist/itens/${it.id}`, { method: 'DELETE' }); invalidate(); }
    catch (e: any) { toast({ title: 'Erro ao remover', description: String(e.message || e), variant: 'destructive' }); }
  };
  const enviarFoto = async (it: any, file: File | undefined) => {
    if (!file) return;
    setBusy('foto-' + it.id);
    try {
      const blob = await carimbarFoto(file, [`${agoraBR()}  •  ${nomeUsuario}`, `Checklist ${fmtData(data)} — ${it.description}`.slice(0, 90)]);
      const fd = new FormData();
      fd.append('arquivo', blob, `checklist_${data}_${it.id.slice(0, 8)}.jpg`);
      await jfetch(`/api/industria/checklist/itens/${it.id}/foto`, { method: 'POST', body: fd });
      toast({ title: 'Foto anexada', description: `${it.description} — ${agoraBR()}` }); invalidate();
    } catch (e: any) { toast({ title: 'Erro ao anexar foto', description: String(e.message || e), variant: 'destructive' }); }
    finally { setBusy(null); }
  };
  const enviarArquivos = async (it: any, files: FileList | null) => {
    const lista = Array.from(files || []); if (!lista.length) return;
    setBusy('arq-' + it.id);
    let okN = 0; const falhas: string[] = [];
    for (const file of lista) {
      const fd = new FormData(); fd.append('arquivo', file, file.name);
      try { await jfetch(`/api/industria/checklist/itens/${it.id}/arquivos`, { method: 'POST', body: fd }); okN++; } catch (e: any) { falhas.push(`${file.name}: ${e.message || e}`); }
    }
    setBusy(null); invalidate();
    toast({ title: `${okN} arquivo(s) anexado(s)`, description: falhas.length ? falhas.join('; ') : it.description, variant: falhas.length ? 'destructive' : undefined });
  };
  const removerArquivo = async (a: any) => {
    if (!window.confirm(`Remover o arquivo "${a.fileName}"?`)) return;
    try { await jfetch(`/api/industria/checklist/arquivos/${a.id}`, { method: 'DELETE' }); invalidate(); }
    catch (e: any) { toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' }); }
  };
  const removerFoto = async (it: any) => {
    if (!window.confirm('Remover a foto deste item?')) return;
    try { await jfetch(`/api/industria/checklist/itens/${it.id}/foto`, { method: 'DELETE' }); setFotoAberta(null); invalidate(); }
    catch (e: any) { toast({ title: 'Erro', description: String(e.message || e), variant: 'destructive' }); }
  };

  const diasLista: any[] = dias.data?.dias || [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4">
      {/* Lista de dias */}
      <Card className="h-fit">
        <CardContent className="p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold flex items-center gap-1"><CalendarDays className="h-4 w-4" /> Dias de produção</span>
            <Button variant="ghost" size="sm" onClick={() => dias.refetch()}><RefreshCw className={`h-4 w-4 ${dias.isFetching ? 'animate-spin' : ''}`} /></Button>
          </div>
          <Button size="sm" variant={data === hojeISO() ? 'default' : 'outline'} className="w-full" onClick={() => setData(hojeISO())}>Hoje · {fmtData(hojeISO())}</Button>
          <div className="max-h-[60vh] overflow-auto space-y-1">
            {diasLista.length === 0 && <p className="text-xs text-gray-400 px-1">Nenhum checklist ainda. Escolha o dia e adicione os itens.</p>}
            {diasLista.map((d) => (
              <button key={d.id} type="button" onClick={() => setData(d.date)}
                className={`w-full text-left rounded-md border px-2 py-1.5 text-xs hover:bg-gray-50 ${d.date === data ? 'border-emerald-400 bg-emerald-50' : ''}`}>
                <div className="flex items-center justify-between">
                  <span className="font-medium">{fmtData(d.date)}</span>
                  <span className="text-[10px] text-gray-500">{d.total} item(ns)</span>
                </div>
                <div className="flex gap-1 mt-1">
                  {d.ok > 0 && <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100 text-[10px] px-1 py-0">{d.ok} ok</Badge>}
                  {d.naoConforme > 0 && <Badge className="bg-red-100 text-red-700 hover:bg-red-100 text-[10px] px-1 py-0">{d.naoConforme} NC</Badge>}
                  {d.pendentes > 0 && <Badge className="bg-gray-100 text-gray-700 hover:bg-gray-100 text-[10px] px-1 py-0">{d.pendentes} pend.</Badge>}
                  {d.fotos > 0 && <span className="text-[10px] text-gray-500 inline-flex items-center gap-0.5"><ImageIcon className="h-3 w-3" />{d.fotos}</span>}
                </div>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Checklist do dia */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={() => setData(somaDias(data, -1))}><ChevronLeft className="h-4 w-4" /></Button>
          <Input type="date" value={data} onChange={(e) => e.target.value && setData(e.target.value)} className="w-[170px]" />
          <Button variant="outline" size="sm" onClick={() => setData(somaDias(data, 1))}><ChevronRight className="h-4 w-4" /></Button>
          <span className="text-sm text-gray-600 capitalize">{diaSemana(data)}</span>
          <div className="flex-1" />
          <span className="text-xs text-gray-500">{resumo.total} item(ns) · {resumo.ok} conforme · {resumo.nc} não conforme · {resumo.pend} pendente(s) · {resumo.fotos} foto(s)</span>
          <Button variant="outline" size="sm" onClick={copiarAnterior} disabled={busy === 'copiar'} title="Copia os itens do último checklist anterior a este dia">
            {busy === 'copiar' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Copy className="h-4 w-4 mr-1" />} Copiar do dia anterior
          </Button>
        </div>

        <Card><CardContent className="p-3 space-y-2">
          <div className="text-sm font-semibold">Novo item a verificar</div>
          <div className="flex gap-2 items-start">
            <Textarea rows={2} value={novo} onChange={(e) => setNovo(e.target.value)} placeholder={'Ex.: Higienização da envasadora\nUma linha por item (várias de uma vez)'} className="text-sm" />
            <Button onClick={addItem} disabled={!novo.trim() || busy === 'add'} className="bg-emerald-600 hover:bg-emerald-700 text-white h-auto self-stretch">
              {busy === 'add' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            </Button>
          </div>
        </CardContent></Card>

        {ck.isLoading && <p className="text-sm text-gray-400">Carregando...</p>}
        {!ck.isLoading && items.length === 0 && (
          <Card><CardContent className="p-6 text-center text-sm text-gray-400">Sem itens para {fmtData(data)}. Adicione acima ou copie do dia anterior.</CardContent></Card>
        )}
        <div className="space-y-2">
          {items.map((it, idx) => {
            const st = STATUS[it.status] || STATUS.pendente;
            return (
              <Card key={it.id} className={it.status === 'nao_conforme' ? 'border-red-200' : it.status === 'ok' ? 'border-emerald-200' : ''}>
                <CardContent className="p-3">
                  <div className="flex items-start gap-3">
                    <span className="text-xs text-gray-400 font-mono mt-1 w-6">{idx + 1}.</span>
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="flex items-start gap-2 flex-wrap">
                        <span className="font-medium text-sm flex-1 min-w-[200px]">{it.description}</span>
                        <Badge className={`${st.cls} hover:${st.cls}`}>{st.label}</Badge>
                      </div>
                      <div className="flex items-center gap-1 flex-wrap">
                        <Button size="sm" variant={it.status === 'ok' ? 'default' : 'outline'} className={it.status === 'ok' ? 'bg-emerald-600 hover:bg-emerald-700' : ''} disabled={busy === it.id} onClick={() => setStatus(it, 'ok')}><CheckCircle2 className="h-4 w-4 mr-1" /> Conforme</Button>
                        <Button size="sm" variant={it.status === 'nao_conforme' ? 'destructive' : 'outline'} disabled={busy === it.id} onClick={() => setStatus(it, 'nao_conforme')}><XCircle className="h-4 w-4 mr-1" /> Não conforme</Button>
                        <Button size="sm" variant="outline" disabled={busy === it.id} onClick={() => setStatus(it, 'nao_aplicavel')}><MinusCircle className="h-4 w-4 mr-1" /> N/A</Button>
                        {it.status !== 'pendente' && <Button size="sm" variant="ghost" disabled={busy === it.id} onClick={() => setStatus(it, 'pendente')}>Desfazer</Button>}
                        <div className="flex-1" />
                        <input type="file" accept="image/*" capture="environment" className="hidden"
                          ref={(el) => { fileRefs.current[it.id] = el; }}
                          onChange={(e) => { enviarFoto(it, e.target.files?.[0]); e.target.value = ''; }} />
                        <Button size="sm" variant="outline" disabled={busy === 'foto-' + it.id} onClick={() => fileRefs.current[it.id]?.click()} title="Tirar/anexar foto (carimbada com data, hora e usuário)">
                          {busy === 'foto-' + it.id ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Camera className="h-4 w-4 mr-1" />} {it.hasPhoto ? 'Trocar foto' : 'Foto'}
                        </Button>
                        <input type="file" multiple className="hidden"
                          ref={(el) => { arqRefs.current[it.id] = el; }}
                          onChange={(e) => { enviarArquivos(it, e.target.files); e.target.value = ''; }} />
                        <Button size="sm" variant="outline" disabled={busy === 'arq-' + it.id} onClick={() => arqRefs.current[it.id]?.click()} title="Anexar arquivo de qualquer tipo (laudo, planilha, PDF... até 25MB)">
                          {busy === 'arq-' + it.id ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Paperclip className="h-4 w-4 mr-1" />} Arquivo{(it.arquivos?.length || 0) > 0 ? ` (${it.arquivos.length})` : ''}
                        </Button>
                        <Button size="sm" variant="ghost" className="text-red-500" onClick={() => removerItem(it)} title="Remover item"><Trash2 className="h-4 w-4" /></Button>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2 items-start">
                        <Textarea rows={1} defaultValue={it.notes || ''} placeholder="Observação (o que foi visto, ação tomada...)" className="text-xs"
                          onBlur={(e) => salvarNota(it, e.target.value)} />
                        {it.hasPhoto && (
                          <button type="button" onClick={() => setFotoAberta(it)} className="shrink-0" title={`Foto de ${fmtHora(it.photoTakenAt)} por ${it.photoBy || '-'}`}>
                            <img src={`/api/industria/checklist/itens/${it.id}/foto?v=${encodeURIComponent(it.photoTakenAt || '')}`} alt="foto" className="h-16 w-24 object-cover rounded border" />
                          </button>
                        )}
                      </div>
                      {(it.arquivos?.length || 0) > 0 && (
                        <div className="space-y-1">
                          {it.arquivos.map((a: any) => (
                            <div key={a.id} className="flex items-center gap-2 rounded border px-2 py-1 text-xs bg-white">
                              <FileText className="h-4 w-4 text-gray-500 shrink-0" />
                              <div className="min-w-0 flex-1">
                                <a href={`/api/industria/checklist/arquivos/${a.id}/download`} target="_blank" rel="noreferrer" className="font-medium text-blue-700 hover:underline truncate block" title={a.fileName}>{a.fileName}</a>
                                <div className="text-[10px] text-gray-400 truncate">{fmtBytes(a.fileSize)} · {fmtHora(a.createdAt)}{a.createdBy ? ` · ${a.createdBy}` : ''}</div>
                              </div>
                              <a href={`/api/industria/checklist/arquivos/${a.id}/download?download=1`} title="Baixar"><Button size="sm" variant="ghost" className="h-6 px-1"><Download className="h-3 w-3" /></Button></a>
                              <Button size="sm" variant="ghost" className="h-6 px-1 text-red-500" title="Remover" onClick={() => removerArquivo(a)}><Trash2 className="h-3 w-3" /></Button>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="text-[11px] text-gray-500 flex gap-3 flex-wrap">
                        <span>Criado {fmtHora(it.createdAt)}{it.createdBy ? ` por ${it.createdBy}` : ''}</span>
                        {it.checkedAt && <span>Registrado <b>{fmtHora(it.checkedAt)}</b>{it.checkedBy ? ` por ${it.checkedBy}` : ''}</span>}
                        {it.hasPhoto && <span>Foto <b>{fmtHora(it.photoTakenAt)}</b>{it.photoBy ? ` por ${it.photoBy}` : ''}</span>}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {fotoAberta && (
        <Dialog open onOpenChange={(v) => { if (!v) setFotoAberta(null); }}>
          <DialogContent className="max-w-3xl">
            <DialogHeader><DialogTitle>{fotoAberta.description}</DialogTitle></DialogHeader>
            <img src={`/api/industria/checklist/itens/${fotoAberta.id}/foto`} alt="foto" className="max-h-[70vh] w-auto mx-auto rounded" />
            <div className="flex items-center justify-between text-xs text-gray-500">
              <span>Foto {fmtHora(fotoAberta.photoTakenAt)}{fotoAberta.photoBy ? ` por ${fotoAberta.photoBy}` : ''}</span>
              <div className="flex gap-2">
                <a href={`/api/industria/checklist/itens/${fotoAberta.id}/foto`} target="_blank" rel="noreferrer"><Button size="sm" variant="outline">Abrir</Button></a>
                <Button size="sm" variant="ghost" className="text-red-500" onClick={() => removerFoto(fotoAberta)}><Trash2 className="h-4 w-4 mr-1" /> Remover</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
