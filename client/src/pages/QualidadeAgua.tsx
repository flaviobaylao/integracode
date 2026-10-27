// ============================================================================
// QUALIDADE DA ÁGUA (Tuya) — 27/out/2026, Fase 3
// Analisadores de água (ex.: "LEITOR DE PH/ORP/CLORO AGUA", 8 in 1) pareados no
// Smart Life. Aba própria, separada das temperaturas: cards com TODOS os
// parâmetros atuais (pH, ORP, TDS, EC, salinidade, CF, densidade, temperatura,
// RH…) com limites de alarme do aparelho, período + intervalo, um gráfico por
// parâmetro (unidades diferentes), tabela e CSV.
// Backend: /api/tuya/agua/* (server/tuya-agua.ts). Menu: Indústria › Qualidade da Água.
// ============================================================================
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import BackToDashboardButton from '@/components/BackToDashboardButton';
import { Droplets, RefreshCw, Download, Loader2, Wifi, WifiOff, AlertTriangle, Clock } from 'lucide-react';

const jfetch = async (url: string, opts: any = {}) => {
  const r = await fetch(url, { credentials: 'include', headers: opts.body ? { 'Content-Type': 'application/json' } : undefined, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(j?.error || j?.message || `Falha (${r.status})`);
  return j;
};
const pad = (n: number) => String(n).padStart(2, '0');
const toLocalInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fromLocalInput = (s: string) => { if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d.toISOString(); };
const fmtDateTime = (iso: string, sec = false) => { const d = new Date(iso); return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', ...(sec ? { second: '2-digit' } : {}) }); };
const fmtVal = (v: number | null | undefined, decimals = 1, unit = '') => (v == null ? '—' : `${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${unit ? ' ' + unit : ''}`);
const ago = (iso?: string | null) => { if (!iso) return 'sem leitura'; const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000)); return s < 90 ? `há ${s} s` : s < 5400 ? `há ${Math.round(s / 60)} min` : s < 172800 ? `há ${Math.round(s / 3600)} h` : `há ${Math.round(s / 86400)} d`; };

const BUCKETS = [
  { value: 'raw', label: 'Bruto (≈ 1 min)' }, { value: '1m', label: '1 minuto' }, { value: '1h', label: '1 hora' },
  { value: '4h', label: '4 horas' }, { value: '8h', label: '8 horas' }, { value: '12h', label: '12 horas' }, { value: '24h', label: '24 horas' },
];
type Preset = 'hoje' | '24h' | '7d' | '30d' | 'custom';
const PRESETS: { id: Preset; label: string }[] = [{ id: 'hoje', label: 'Hoje' }, { id: '24h', label: '24 h' }, { id: '7d', label: '7 dias' }, { id: '30d', label: '30 dias' }];
const presetRange = (p: Preset) => { const to = new Date(); if (p === 'hoje') { const f = new Date(); f.setHours(0, 0, 0, 0); return { from: f, to }; } const h = p === '24h' ? 24 : p === '7d' ? 168 : 720; return { from: new Date(to.getTime() - h * 3600000), to }; };
const suggestBucket = (p: Preset) => (p === 'hoje' || p === '24h' ? 'raw' : p === '7d' ? '1h' : '4h');
const COLORS = ['#0891b2', '#dc2626', '#7c3aed', '#059669', '#f59e0b', '#2563eb', '#db2777', '#4b5563', '#ca8a04', '#0d9488'];

type Param = { code: string; dp_id: number | null; label: string; unit: string; decimals: number; nota: string | null; value: number | null; raw: number | null; read_at: string | null; warn_max: number | null; warn_min: number | null; limites_ativos: boolean; fora_dos_limites: boolean };
type Device = { device_id: string; name: string; product_name: string | null; online: boolean; last_poll_at: string | null; last_error: string | null; params: Param[]; outros: any[] };

export default function QualidadeAgua() {
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>('24h');
  const init = presetRange('24h');
  const [fromStr, setFromStr] = useState(toLocalInput(init.from));
  const [toStr, setToStr] = useState(toLocalInput(init.to));
  const [bucket, setBucket] = useState('raw');
  const [exporting, setExporting] = useState(false);
  const [tableLimit, setTableLimit] = useState(200);

  const devicesQ = useQuery({ queryKey: ['/api/tuya/agua/devices'], queryFn: () => jfetch('/api/tuya/agua/devices'), refetchInterval: 60_000 });
  const devices: Device[] = devicesQ.data?.devices || [];
  useEffect(() => { if (!selectedId && devices.length) setSelectedId(devices[0].device_id); }, [devices, selectedId]);
  const selected = devices.find((d) => d.device_id === selectedId) || null;

  const applyPreset = (p: Preset) => { setPreset(p); if (p === 'custom') return; const r = presetRange(p); setFromStr(toLocalInput(r.from)); setToStr(toLocalInput(r.to)); setBucket(suggestBucket(p)); };
  useEffect(() => { if (preset === 'custom') return; const id = setInterval(() => { const r = presetRange(preset); setFromStr(toLocalInput(r.from)); setToStr(toLocalInput(r.to)); }, 60_000); return () => clearInterval(id); }, [preset]);
  const fromIso = fromLocalInput(fromStr), toIso = fromLocalInput(toStr);
  const periodOk = !!fromIso && !!toIso && fromIso < toIso;
  const spanHours = periodOk ? (new Date(toIso!).getTime() - new Date(fromIso!).getTime()) / 3600000 : 0;

  const readingsQ = useQuery({
    queryKey: ['/api/tuya/agua/readings', selectedId, fromIso, toIso, bucket],
    queryFn: () => jfetch(`/api/tuya/agua/devices/${encodeURIComponent(selectedId!)}/readings?from=${encodeURIComponent(fromIso!)}&to=${encodeURIComponent(toIso!)}&bucket=${bucket}`),
    enabled: !!selectedId && periodOk, placeholderData: (prev: any) => prev,
  });
  const codes: string[] = readingsQ.data?.codes || [];
  const defs: Record<string, { label: string; unit: string; decimals: number; div: number }> = readingsQ.data?.defs || {};
  const points: any[] = readingsQ.data?.points || [];
  const isRaw = bucket === 'raw';
  const chartData = useMemo(() => points.map((p) => ({ ...p, ts: new Date(p.t).getTime() })), [points]);
  const xTick = (ts: number) => { const d = new Date(ts); return spanHours <= 48 ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}h`; };
  const paramByCode = (c: string) => selected?.params.find((p) => p.code === c);

  const refreshDevices = async () => {
    try { const j = await jfetch('/api/tuya/agua/devices?refresh=1'); toast({ title: 'Analisadores atualizados', description: `${j.total} aparelho(s)` + (j.refreshError ? ` — Tuya: ${j.refreshError}` : '') }); devicesQ.refetch(); }
    catch (e: any) { toast({ title: 'Erro', description: e.message, variant: 'destructive' }); }
  };
  const exportCsv = async () => {
    if (!selectedId || !periodOk) return; setExporting(true);
    try {
      const r = await fetch(`/api/tuya/agua/devices/${encodeURIComponent(selectedId)}/readings.csv?from=${encodeURIComponent(fromIso!)}&to=${encodeURIComponent(toIso!)}&bucket=${bucket}`, { credentials: 'include' });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j?.error || `Falha (${r.status})`); }
      const blob = await r.blob(); const m = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = m?.[1] || 'qualidade_agua.csv'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e: any) { toast({ title: 'Erro ao exportar', description: e.message, variant: 'destructive' }); } finally { setExporting(false); }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="p-4 md:p-6">
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <BackToDashboardButton />
          <div className="flex items-center gap-3">
            <div className="p-2 bg-cyan-100 rounded-lg"><Droplets className="h-6 w-6 text-cyan-700" /></div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Qualidade da Água</h1>
              <p className="text-sm text-gray-500">Analisadores de água (nuvem Tuya) — leitura a cada 60 s, histórico permanente</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
          <Card className="h-fit">
            <CardContent className="p-3">
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-semibold text-gray-800 dark:text-gray-100">Analisadores</h2>
                <Button variant="ghost" size="sm" onClick={refreshDevices} disabled={devicesQ.isFetching} title="Relistar na Tuya"><RefreshCw className={`h-4 w-4 ${devicesQ.isFetching ? 'animate-spin' : ''}`} /></Button>
              </div>
              {devicesQ.isLoading && <div className="text-sm text-gray-500 flex items-center gap-2 p-2"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>}
              {!devicesQ.isLoading && !devices.length && <div className="text-sm text-gray-500 p-2">Nenhum analisador de água no projeto Tuya. Pareie o aparelho no app <b>Smart Life</b> e clique em atualizar.</div>}
              <div className="space-y-1.5">
                {devices.map((d) => {
                  const ph = d.params.find((p) => p.code === 'ph_current');
                  const fora = d.params.filter((p) => p.fora_dos_limites).length;
                  return (
                    <button key={d.device_id} onClick={() => setSelectedId(d.device_id)}
                      className={`w-full text-left rounded-lg border px-3 py-2 transition ${d.device_id === selectedId ? 'border-cyan-500 bg-cyan-50 dark:bg-cyan-900/20' : 'border-gray-200 bg-white hover:bg-gray-50 dark:bg-gray-800 dark:border-gray-700'}`}>
                      <div className="flex items-center gap-2">
                        {d.online ? <Wifi className="h-4 w-4 text-cyan-600 shrink-0" /> : <WifiOff className="h-4 w-4 text-gray-400 shrink-0" />}
                        <span className="font-medium text-sm truncate flex-1">{d.name}</span>
                        {ph && <span className="text-base font-semibold text-cyan-700">pH {fmtVal(ph.value, 2)}</span>}
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-gray-500 mt-0.5">
                        <span className="truncate">{d.product_name || d.device_id}</span>
                        <span>{ago(ph?.read_at || d.last_poll_at)}</span>
                      </div>
                      <div className="text-[11px] text-gray-500">{d.params.length} parâmetro(s){fora ? <span className="text-red-600"> · {fora} fora do limite</span> : null}</div>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <div className="space-y-4 min-w-0">
            {/* Valores atuais */}
            {selected && (
              <Card>
                <CardContent className="p-3 md:p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h2 className="font-semibold text-gray-800 dark:text-gray-100">{selected.name} — valores atuais</h2>
                    <span className="text-xs text-gray-500 flex items-center gap-1"><Clock className="h-3 w-3" /> coletor {ago(selected.last_poll_at)}</span>
                  </div>
                  {selected.last_error && <div className="text-xs text-red-600 mb-2">⚠ {selected.last_error}</div>}
                  <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2">
                    {selected.params.map((p, i) => (
                      <div key={p.code} className={`rounded-lg border p-2 ${p.fora_dos_limites ? 'border-red-300 bg-red-50' : ''}`} style={{ borderLeft: `4px solid ${COLORS[i % COLORS.length]}` }} title={p.nota || p.code}>
                        <div className="text-[10px] uppercase tracking-wide text-gray-500 truncate">{p.label}</div>
                        <div className="text-lg font-semibold text-gray-900 dark:text-white">{fmtVal(p.value, p.decimals, p.unit)}</div>
                        <div className="text-[10px] text-gray-500">
                          {p.limites_ativos ? `limites ${fmtVal(p.warn_min, p.decimals)} – ${fmtVal(p.warn_max, p.decimals)}` : 'sem limite no aparelho'} · {ago(p.read_at)}
                        </div>
                        {p.fora_dos_limites && <div className="text-[10px] text-red-600 flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> fora do limite</div>}
                      </div>
                    ))}
                  </div>
                  {selected.params.some((p) => p.nota) && (
                    <p className="text-[11px] text-gray-500 mt-2">{selected.params.filter((p) => p.nota).map((p) => `${p.label}: ${p.nota}`).join(' · ')}</p>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Filtros */}
            <Card>
              <CardContent className="p-3 md:p-4">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex items-center gap-1">{PRESETS.map((p) => <Button key={p.id} size="sm" variant={preset === p.id ? 'default' : 'outline'} className={preset === p.id ? 'bg-cyan-600 hover:bg-cyan-700' : ''} onClick={() => applyPreset(p.id)}>{p.label}</Button>)}</div>
                  <div><Label className="text-xs text-gray-500">Início</Label><Input type="datetime-local" value={fromStr} onChange={(e) => { setFromStr(e.target.value); setPreset('custom'); }} className="h-9 w-[200px]" /></div>
                  <div><Label className="text-xs text-gray-500">Fim</Label><Input type="datetime-local" value={toStr} onChange={(e) => { setToStr(e.target.value); setPreset('custom'); }} className="h-9 w-[200px]" /></div>
                  <div><Label className="text-xs text-gray-500">Intervalo entre pontos</Label>
                    <Select value={bucket} onValueChange={setBucket}><SelectTrigger className="h-9 w-[170px]"><SelectValue /></SelectTrigger><SelectContent>{BUCKETS.map((b) => <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>)}</SelectContent></Select></div>
                  <div className="ml-auto flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => readingsQ.refetch()} disabled={!selectedId || readingsQ.isFetching}><RefreshCw className={`h-4 w-4 mr-1 ${readingsQ.isFetching ? 'animate-spin' : ''}`} /> Atualizar</Button>
                    <Button size="sm" className="bg-cyan-600 hover:bg-cyan-700" onClick={exportCsv} disabled={!selectedId || !periodOk || exporting || !points.length}>{exporting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />} CSV</Button>
                  </div>
                </div>
                {!periodOk && <div className="text-xs text-red-600 mt-2">Período inválido.</div>}
                {readingsQ.data?.truncated && <div className="text-xs text-red-600 mt-2">Período longo demais para o modo Bruto — use um intervalo maior.</div>}
              </CardContent>
            </Card>

            {/* Um gráfico por parâmetro */}
            {!selectedId ? null : readingsQ.isLoading ? (
              <Card><CardContent className="p-6 text-sm text-gray-500 flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Carregando leituras…</CardContent></Card>
            ) : !points.length ? (
              <Card><CardContent className="p-6 text-sm text-gray-500">Sem leituras neste período.</CardContent></Card>
            ) : (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                {codes.map((c, i) => {
                  const d = defs[c] || { label: c, unit: '', decimals: 1 };
                  const pr = paramByCode(c);
                  const color = COLORS[i % COLORS.length];
                  return (
                    <Card key={c}>
                      <CardContent className="p-3">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-semibold text-sm" style={{ color }}>{d.label}{d.unit ? ` (${d.unit})` : ''}</span>
                          <span className="text-xs text-gray-500">atual {fmtVal(pr?.value, d.decimals, d.unit)}</span>
                        </div>
                        <div className="h-[200px]">
                          <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={chartData} margin={{ top: 6, right: 10, left: 0, bottom: 2 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                              <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={xTick} minTickGap={40} tick={{ fontSize: 10 }} />
                              <YAxis width={44} tick={{ fontSize: 10 }} domain={['auto', 'auto']} />
                              <Tooltip labelFormatter={(v) => fmtDateTime(new Date(Number(v)).toISOString(), isRaw)} formatter={(v: any, name: any) => [fmtVal(v == null ? null : Number(v), d.decimals, d.unit), name]} />
                              {pr?.limites_ativos && pr.warn_max != null && <ReferenceLine y={pr.warn_max} stroke="#dc2626" strokeDasharray="4 3" label={{ value: 'máx', fontSize: 10, fill: '#dc2626' }} />}
                              {pr?.limites_ativos && pr.warn_min != null && <ReferenceLine y={pr.warn_min} stroke="#2563eb" strokeDasharray="4 3" label={{ value: 'mín', fontSize: 10, fill: '#2563eb' }} />}
                              {!isRaw && <Line type="linear" dataKey={`${c}__max`} name="máx" stroke={color} strokeOpacity={0.4} strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls />}
                              <Line type="linear" dataKey={`${c}__avg`} name={isRaw ? d.label : 'média'} stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
                              {!isRaw && <Line type="linear" dataKey={`${c}__min`} name="mín" stroke={color} strokeOpacity={0.4} strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls />}
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}

            {/* Tabela */}
            {!!points.length && (
              <Card>
                <CardContent className="p-0">
                  <div className="flex items-center justify-between px-4 py-3 border-b">
                    <h2 className="font-semibold text-gray-800 dark:text-gray-100">Leituras</h2>
                    <span className="text-xs text-gray-500">mostrando {Math.min(tableLimit, points.length)} de {points.length} (mais recentes primeiro){!isRaw ? ' · valores médios do intervalo' : ''}</span>
                  </div>
                  <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
                    <Table>
                      <TableHeader className="sticky top-0 bg-white dark:bg-gray-800 z-10">
                        <TableRow>
                          <TableHead>{isRaw ? 'Data/hora' : 'Início do intervalo'}</TableHead>
                          {codes.map((c) => <TableHead key={c} className="text-right whitespace-nowrap">{defs[c]?.label || c}{defs[c]?.unit ? ` (${defs[c].unit})` : ''}</TableHead>)}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {points.slice().reverse().slice(0, tableLimit).map((p) => (
                          <TableRow key={p.t}>
                            <TableCell className="whitespace-nowrap">{fmtDateTime(p.t, isRaw)}</TableCell>
                            {codes.map((c) => <TableCell key={c} className="text-right">{fmtVal(p[`${c}__avg`], defs[c]?.decimals ?? 1)}</TableCell>)}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {points.length > tableLimit && <div className="p-3 border-t text-center"><Button variant="outline" size="sm" onClick={() => setTableLimit((n) => n + 500)}>Mostrar mais 500</Button></div>}
                </CardContent>
              </Card>
            )}

            {/* Outros DPs (sensor_list etc.) */}
            {selected && selected.outros?.length > 0 && (
              <Card><CardContent className="p-3 text-xs text-gray-500">
                <span className="font-semibold text-gray-700">Outros dados do aparelho:</span> {selected.outros.map((o: any) => `${o.code} (${o.type}) = ${o.value_text || '—'}`).join(' · ')}
              </CardContent></Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
