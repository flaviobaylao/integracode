// ============================================================================
// TEMPERATURAS (Tuya / Coel E34B) — 27/out/2026
// Histórico de temperatura de TODOS os controladores vinculados ao projeto Tuya
// "Integra Honest". Lista de aparelhos vem da própria Tuya (sem cadastro manual);
// o coletor do servidor grava a cada 60 s em tuya_temperature_readings (retido
// para sempre). Esta tela: período (data/hora inicial e final + atalhos),
// intervalo entre pontos (Bruto ≈ 1 min · 1 min · 1 h · 4 h · 8 h · 12 h · 24 h,
// agregando mín/méd/máx a partir do bruto), gráfico de linhas (sonda principal e
// evaporador), tabela das leituras e exportação CSV. O servidor grava TODOS os
// DPs do aparelho (38 no E34B): painel "Todos os DPs" mostra o último valor de
// cada um e o botão "CSV completo" exporta tudo no período (formato longo).
// Backend: /api/tuya/* (server/tuya-routes.ts). Menu: Indústria › Temperaturas.
// ============================================================================
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import BackToDashboardButton from '@/components/BackToDashboardButton';
import {
  Thermometer, RefreshCw, Download, Loader2, Wifi, WifiOff, AlertTriangle, Snowflake, Activity, Clock, ListTree, ChevronDown, ChevronUp,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const jfetch = async (url: string, opts: any = {}) => {
  const r = await fetch(url, { credentials: 'include', headers: opts.body ? { 'Content-Type': 'application/json' } : undefined, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) throw new Error(j?.error || j?.message || `Falha (${r.status})`);
  return j;
};

const pad = (n: number) => String(n).padStart(2, '0');
/** Date → valor de <input type="datetime-local"> no fuso do navegador. */
const toLocalInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** valor do input → ISO (UTC) p/ a API. */
const fromLocalInput = (s: string): string | null => {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
};
const fmtDateTime = (iso: string, withSeconds = false) => {
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}) });
};
const fmtTemp = (v: number | null | undefined, digits = 1) => (v == null ? '—' : `${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })} °C`);
const ago = (iso?: string | null) => {
  if (!iso) return 'sem leitura';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return `há ${s} s`;
  if (s < 5400) return `há ${Math.round(s / 60)} min`;
  if (s < 172800) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} d`;
};

const BUCKETS = [
  { value: 'raw', label: 'Bruto (≈ 1 min)' },
  { value: '1m', label: '1 minuto' },
  { value: '1h', label: '1 hora' },
  { value: '4h', label: '4 horas' },
  { value: '8h', label: '8 horas' },
  { value: '12h', label: '12 horas' },
  { value: '24h', label: '24 horas' },
];
type Preset = 'hoje' | '24h' | '7d' | '30d' | 'custom';
const PRESETS: { id: Preset; label: string }[] = [
  { id: 'hoje', label: 'Hoje' }, { id: '24h', label: '24 h' }, { id: '7d', label: '7 dias' }, { id: '30d', label: '30 dias' },
];
const presetRange = (p: Preset): { from: Date; to: Date } => {
  const to = new Date();
  if (p === 'hoje') { const f = new Date(); f.setHours(0, 0, 0, 0); return { from: f, to }; }
  const h = p === '24h' ? 24 : p === '7d' ? 24 * 7 : 24 * 30;
  return { from: new Date(to.getTime() - h * 3600 * 1000), to };
};
/** Intervalo sugerido p/ o período (evita gráfico com 43 mil pontos sem querer). */
const suggestBucket = (p: Preset) => (p === 'hoje' || p === '24h' ? 'raw' : p === '7d' ? '1h' : '4h');

type Device = {
  device_id: string; name: string; product_name: string | null; category: string | null; online: boolean;
  last_seen_at: string | null; last_poll_at: string | null; last_error: string | null;
  last_main_celsius: number | null; last_main_at: string | null;
  last_evap_celsius: number | null; last_evap_at: string | null;
  readings_main: number; first_reading_at: string | null;
  main_label?: string; evap_label?: string;   // rótulos por aparelho (ex.: Resfriamento da Pasteurização)
};
type Point = {
  t: string; n: number;
  main_min: number | null; main_avg: number | null; main_max: number | null;
  evap_min: number | null; evap_avg: number | null; evap_max: number | null;
};

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------
export default function Temperaturas() {
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>('24h');
  const initial = presetRange('24h');
  const [fromStr, setFromStr] = useState(toLocalInput(initial.from));
  const [toStr, setToStr] = useState(toLocalInput(initial.to));
  const [bucket, setBucket] = useState('raw');
  const [showEvap, setShowEvap] = useState(true);
  const [showMinMax, setShowMinMax] = useState(true);
  const [tableLimit, setTableLimit] = useState(200);
  const [exporting, setExporting] = useState(false);
  const [exportingAll, setExportingAll] = useState(false);
  const [showDps, setShowDps] = useState(false);

  // --- controladores (lista vem da Tuya via cache do servidor) ---------------
  const devicesQ = useQuery({
    queryKey: ['/api/tuya/devices'],
    queryFn: () => jfetch('/api/tuya/devices'),
    refetchInterval: 60_000,
  });
  const devices: Device[] = devicesQ.data?.devices || [];
  const collector = devicesQ.data?.collector;
  const configured: boolean = devicesQ.data?.configured !== false;

  useEffect(() => {
    if (!selectedId && devices.length) setSelectedId(devices[0].device_id);
  }, [devices, selectedId]);
  const selected = devices.find((d) => d.device_id === selectedId) || null;

  const refreshDevices = async () => {
    try {
      const j = await jfetch('/api/tuya/devices?refresh=1');
      if (j.refreshError) toast({ title: 'Lista atualizada do banco', description: 'A Tuya não respondeu: ' + j.refreshError, variant: 'destructive' });
      else toast({ title: 'Controladores atualizados', description: `${j.total} aparelho(s) no projeto Tuya.` });
      devicesQ.refetch();
    } catch (e: any) { toast({ title: 'Erro ao listar', description: e.message, variant: 'destructive' }); }
  };

  // --- período -----------------------------------------------------------------
  const applyPreset = (p: Preset) => {
    setPreset(p);
    if (p === 'custom') return;
    const r = presetRange(p);
    setFromStr(toLocalInput(r.from));
    setToStr(toLocalInput(r.to));
    setBucket(suggestBucket(p));
  };
  const fromIso = fromLocalInput(fromStr);
  const toIso = fromLocalInput(toStr);
  const periodOk = !!fromIso && !!toIso && fromIso < toIso;
  const spanHours = periodOk ? (new Date(toIso!).getTime() - new Date(fromIso!).getTime()) / 3600000 : 0;

  // --- leituras ----------------------------------------------------------------
  const readingsQ = useQuery({
    queryKey: ['/api/tuya/readings', selectedId, fromIso, toIso, bucket],
    queryFn: () => jfetch(`/api/tuya/devices/${encodeURIComponent(selectedId!)}/readings?from=${encodeURIComponent(fromIso!)}&to=${encodeURIComponent(toIso!)}&bucket=${bucket}`),
    enabled: !!selectedId && periodOk,
    refetchInterval: preset === 'custom' ? false : 60_000,   // período "ao vivo" acompanha o coletor
    placeholderData: (prev: any) => prev,
  });
  useEffect(() => {
    // atalhos "ao vivo": a cada refetch, empurra o fim do período para agora
    if (preset === 'custom') return;
    const id = setInterval(() => { const r = presetRange(preset); setFromStr(toLocalInput(r.from)); setToStr(toLocalInput(r.to)); }, 60_000);
    return () => clearInterval(id);
  }, [preset]);

  // catálogo de TODOS os DPs do aparelho (último valor de cada um)
  const dpsQ = useQuery({
    queryKey: ['/api/tuya/dps', selectedId],
    queryFn: () => jfetch(`/api/tuya/devices/${encodeURIComponent(selectedId!)}/dps`),
    enabled: !!selectedId && showDps,
    refetchInterval: showDps ? 60_000 : false,
  });
  const dps: any[] = dpsQ.data?.dps || [];

  const points: Point[] = readingsQ.data?.points || [];
  const summary = readingsQ.data?.summary || null;
  const isRaw = bucket === 'raw';
  const truncated: boolean = readingsQ.data?.truncated === true;
  // Rótulos das séries: específicos do aparelho quando configurados (tuya_sensor_labels), senão genéricos
  const mainLabel: string = readingsQ.data?.codes?.main_label || selected?.main_label || 'Sonda principal';
  const evapLabel: string = readingsQ.data?.codes?.evap_label || selected?.evap_label || 'Evaporador';

  const chartData = useMemo(() => points.map((p) => ({ ...p, ts: new Date(p.t).getTime() })), [points]);
  const xTick = (ts: number) => {
    const d = new Date(ts);
    return spanHours <= 48 ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      : spanHours <= 24 * 10 ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}h`
      : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  };
  const yDomain = useMemo<[number, number] | undefined>(() => {
    const vals: number[] = [];
    for (const p of points) {
      for (const v of [p.main_min, p.main_max, showEvap ? p.evap_min : null, showEvap ? p.evap_max : null]) if (v != null) vals.push(v);
    }
    if (!vals.length) return undefined;
    const mn = Math.floor(Math.min(...vals) - 1), mx = Math.ceil(Math.max(...vals) + 1);
    return [mn, mx];
  }, [points, showEvap]);

  const download = async (url: string, fallback: string, setBusy: (b: boolean) => void) => {
    setBusy(true);
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j?.error || `Falha (${r.status})`); }
      const blob = await r.blob();
      const m = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = m?.[1] || fallback;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e: any) { toast({ title: 'Erro ao exportar', description: e.message, variant: 'destructive' }); }
    finally { setBusy(false); }
  };
  const qs = () => `from=${encodeURIComponent(fromIso!)}&to=${encodeURIComponent(toIso!)}`;
  const exportCsv = () => selectedId && periodOk && download(`/api/tuya/devices/${encodeURIComponent(selectedId)}/readings.csv?${qs()}&bucket=${bucket}`, `temperaturas_${selectedId}.csv`, setExporting);
  const exportAllCsv = () => selectedId && periodOk && download(`/api/tuya/devices/${encodeURIComponent(selectedId)}/readings-all.csv?${qs()}`, `tuya_todos_dps_${selectedId}.csv`, setExportingAll);

  const collectNow = async () => {
    try {
      const j = await jfetch('/api/tuya/collect-now', { method: 'POST' });
      toast({ title: j.ok ? 'Leitura feita' : 'Leitura com erros', description: `${j.devices} aparelho(s), ${j.inserted} leitura(s) nova(s)${j.errors?.length ? ' — ' + j.errors[0] : ''}`, variant: j.ok ? 'default' : 'destructive' });
      devicesQ.refetch(); readingsQ.refetch();
    } catch (e: any) { toast({ title: 'Erro', description: e.message, variant: 'destructive' }); }
  };

  // ---------------------------------------------------------------------------
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="p-4 md:p-6">
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <BackToDashboardButton />
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-100 rounded-lg"><Thermometer className="h-6 w-6 text-emerald-700" /></div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Temperaturas</h1>
              <p className="text-sm text-gray-500">Controladores Coel (nuvem Tuya) — leitura a cada 60 s, histórico permanente</p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {collector?.trialExpired && (
              <Badge className="bg-red-100 text-red-700 hover:bg-red-100 gap-1"><AlertTriangle className="h-3 w-3" /> Trial IoT Core vencido — renovar na plataforma Tuya</Badge>
            )}
            {!configured && (
              <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 gap-1"><AlertTriangle className="h-3 w-3" /> TUYA_ACCESS_SECRET não configurado</Badge>
            )}
            {collector?.lastRunAt && (
              <span className="text-xs text-gray-500 flex items-center gap-1" title={collector.errors?.length ? collector.errors.join('\n') : 'última rodada do coletor'}>
                <Clock className="h-3 w-3" /> coletor {ago(collector.lastRunAt)}
                {collector.errors?.length ? <span className="text-red-600"> · {collector.errors.length} erro(s)</span> : null}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={collectNow} disabled={!configured}><Activity className="h-4 w-4 mr-1" /> Ler agora</Button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
          {/* ===================== LISTA DE CONTROLADORES ===================== */}
          <Card className="h-fit">
            <CardContent className="p-3">
              <div className="flex items-center justify-between mb-2">
                <h2 className="font-semibold text-gray-800 dark:text-gray-100">Controladores</h2>
                <Button variant="ghost" size="sm" onClick={refreshDevices} disabled={devicesQ.isFetching} title="Relistar na Tuya">
                  <RefreshCw className={`h-4 w-4 ${devicesQ.isFetching ? 'animate-spin' : ''}`} />
                </Button>
              </div>
              {devicesQ.isLoading && <div className="text-sm text-gray-500 flex items-center gap-2 p-2"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>}
              {devicesQ.error && <div className="text-sm text-red-600 p-2">{(devicesQ.error as any).message}</div>}
              {!devicesQ.isLoading && !devices.length && (
                <div className="text-sm text-gray-500 p-2">
                  Nenhum controlador no projeto Tuya. Pareie o aparelho no app <b>Smart Life</b> (conta vinculada ao projeto) e clique em atualizar.
                </div>
              )}
              <div className="space-y-1.5">
                {devices.map((d) => {
                  const active = d.device_id === selectedId;
                  return (
                    <button
                      key={d.device_id}
                      onClick={() => setSelectedId(d.device_id)}
                      className={`w-full text-left rounded-lg border px-3 py-2 transition ${active ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20' : 'border-gray-200 bg-white hover:bg-gray-50 dark:bg-gray-800 dark:border-gray-700'}`}
                      data-testid={`tuya-device-${d.device_id}`}
                    >
                      <div className="flex items-center gap-2">
                        {d.online ? <Wifi className="h-4 w-4 text-emerald-600 shrink-0" /> : <WifiOff className="h-4 w-4 text-gray-400 shrink-0" />}
                        <span className="font-medium text-sm truncate flex-1">{d.name}</span>
                        <span className={`text-base font-semibold ${d.last_main_celsius == null ? 'text-gray-400' : 'text-emerald-700'}`}>{fmtTemp(d.last_main_celsius)}</span>
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-gray-500 mt-0.5">
                        <span className="truncate">{d.product_name || d.category || d.device_id}</span>
                        <span>{ago(d.last_main_at)}</span>
                      </div>
                      {d.last_evap_celsius != null && (
                        <div className="text-[11px] text-gray-500 flex items-center gap-1"><Snowflake className="h-3 w-3" /> {(d.evap_label || "evaporador").toLowerCase()} {fmtTemp(d.last_evap_celsius)}</div>
                      )}
                      {d.last_error && <div className="text-[11px] text-red-600 truncate" title={d.last_error}>⚠ {d.last_error}</div>}
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* ===================== DETALHE ===================== */}
          <div className="space-y-4 min-w-0">
            {/* Filtros */}
            <Card>
              <CardContent className="p-3 md:p-4">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex items-center gap-1">
                    {PRESETS.map((p) => (
                      <Button key={p.id} size="sm" variant={preset === p.id ? 'default' : 'outline'} className={preset === p.id ? 'bg-emerald-600 hover:bg-emerald-700' : ''} onClick={() => applyPreset(p.id)}>{p.label}</Button>
                    ))}
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500">Início</Label>
                    <Input type="datetime-local" value={fromStr} onChange={(e) => { setFromStr(e.target.value); setPreset('custom'); }} className="h-9 w-[200px]" />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500">Fim</Label>
                    <Input type="datetime-local" value={toStr} onChange={(e) => { setToStr(e.target.value); setPreset('custom'); }} className="h-9 w-[200px]" />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500">Intervalo entre pontos</Label>
                    <Select value={bucket} onValueChange={setBucket}>
                      <SelectTrigger className="h-9 w-[170px]"><SelectValue /></SelectTrigger>
                      <SelectContent>{BUCKETS.map((b) => <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
                    <input type="checkbox" checked={showEvap} onChange={(e) => setShowEvap(e.target.checked)} /> {evapLabel}
                  </label>
                  {!isRaw && (
                    <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
                      <input type="checkbox" checked={showMinMax} onChange={(e) => setShowMinMax(e.target.checked)} /> Mín/máx
                    </label>
                  )}
                  <div className="ml-auto flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => readingsQ.refetch()} disabled={!selectedId || readingsQ.isFetching}>
                      <RefreshCw className={`h-4 w-4 mr-1 ${readingsQ.isFetching ? 'animate-spin' : ''}`} /> Atualizar
                    </Button>
                    <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={exportCsv} disabled={!selectedId || !periodOk || exporting || !points.length}>
                      {exporting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />} CSV
                    </Button>
                    <Button size="sm" variant="outline" onClick={exportAllCsv} disabled={!selectedId || !periodOk || exportingAll} title="Todos os DPs do aparelho no período (1 linha por DP/leitura)">
                      {exportingAll ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <ListTree className="h-4 w-4 mr-1" />} CSV completo
                    </Button>
                  </div>
                </div>
                {!periodOk && <div className="text-xs text-red-600 mt-2">Período inválido: o início precisa ser anterior ao fim.</div>}
                {isRaw && spanHours > 24 * 3 && (
                  <div className="text-xs text-amber-700 mt-2">Bruto em {Math.round(spanHours / 24)} dias ≈ {Math.round(spanHours * 60).toLocaleString('pt-BR')} pontos — para períodos longos prefira 1 h ou mais.</div>
                )}
                {truncated && <div className="text-xs text-red-600 mt-2">Período muito longo para o modo Bruto: mostrando só os primeiros 60.000 pontos. Use um intervalo maior.</div>}
              </CardContent>
            </Card>

            {/* KPIs */}
            {selected && (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <Kpi label="Controlador" value={selected.name} sub={selected.online ? 'online' : 'offline'} />
                <Kpi label="Última leitura" value={fmtTemp(selected.last_main_celsius)} sub={selected.last_main_at ? fmtDateTime(selected.last_main_at, true) : '—'} />
                <Kpi label="Mínima no período" value={fmtTemp(summary?.main_min)} />
                <Kpi label="Média no período" value={fmtTemp(summary?.main_avg, 2)} />
                <Kpi label="Máxima no período" value={fmtTemp(summary?.main_max)} sub={summary ? `${summary.raw_count.toLocaleString('pt-BR')} leituras brutas` : undefined} />
              </div>
            )}

            {/* Gráfico */}
            <Card>
              <CardContent className="p-3 md:p-4">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="font-semibold text-gray-800 dark:text-gray-100">
                    Curva de temperatura {selected ? `— ${selected.name}` : ''}
                  </h2>
                  <span className="text-xs text-gray-500">{points.length.toLocaleString('pt-BR')} ponto(s) · {BUCKETS.find((b) => b.value === bucket)?.label}</span>
                </div>
                {!selectedId ? (
                  <div className="h-[360px] flex items-center justify-center text-sm text-gray-500">Selecione um controlador.</div>
                ) : readingsQ.isLoading ? (
                  <div className="h-[360px] flex items-center justify-center text-sm text-gray-500"><Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando leituras…</div>
                ) : readingsQ.error ? (
                  <div className="h-[360px] flex items-center justify-center text-sm text-red-600">{(readingsQ.error as any).message}</div>
                ) : !points.length ? (
                  <div className="h-[360px] flex items-center justify-center text-sm text-gray-500">Sem leituras neste período.</div>
                ) : (
                  <div className="h-[360px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                        <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={xTick} minTickGap={40} tick={{ fontSize: 11 }} />
                        <YAxis domain={yDomain} tickFormatter={(v) => `${v}°`} width={44} tick={{ fontSize: 11 }} allowDataOverflow />
                        <Tooltip
                          labelFormatter={(v) => fmtDateTime(new Date(Number(v)).toISOString(), isRaw)}
                          formatter={(v: any, name: any) => [fmtTemp(v == null ? null : Number(v), 1), name]}
                        />
                        <Legend />
                        {!isRaw && showMinMax && <Line type="linear" dataKey="main_max" name={`${mainLabel} máx`} stroke="#f59e0b" strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls />}
                        <Line type="linear" dataKey="main_avg" name={isRaw ? mainLabel : `${mainLabel} média`} stroke="#059669" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
                        {!isRaw && showMinMax && <Line type="linear" dataKey="main_min" name={`${mainLabel} mín`} stroke="#2563eb" strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls />}
                        {showEvap && <Line type="linear" dataKey="evap_avg" name={isRaw ? evapLabel : `${evapLabel} média`} stroke="#7c3aed" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Todos os DPs do aparelho */}
            {selected && (
              <Card>
                <CardContent className="p-0">
                  <button className="w-full flex items-center justify-between px-4 py-3 text-left" onClick={() => setShowDps((v) => !v)}>
                    <span className="font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2"><ListTree className="h-4 w-4" /> Todos os DPs do aparelho {dpsQ.data ? `(${dps.length})` : ''}</span>
                    <span className="text-xs text-gray-500 flex items-center gap-1">último valor de cada dado gravado {showDps ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</span>
                  </button>
                  {showDps && (
                    <div className="border-t overflow-x-auto max-h-[420px] overflow-y-auto">
                      {dpsQ.isLoading ? <div className="p-4 text-sm text-gray-500 flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>
                      : !dps.length ? <div className="p-4 text-sm text-gray-500">Nenhum DP gravado ainda para este aparelho.</div>
                      : (
                        <Table>
                          <TableHeader className="sticky top-0 bg-white dark:bg-gray-800 z-10">
                            <TableRow>
                              <TableHead>DP</TableHead><TableHead>Código</TableHead><TableHead>Descrição</TableHead><TableHead>Tipo</TableHead>
                              <TableHead className="text-right">Último valor</TableHead><TableHead>Lido em</TableHead><TableHead className="text-right">Leituras</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {dps.map((d) => (
                              <TableRow key={d.code}>
                                <TableCell className="text-gray-500">{d.dp_id ?? '—'}</TableCell>
                                <TableCell className="font-mono text-xs">{d.code}</TableCell>
                                <TableCell>{d.label}{d.custom_name && d.custom_name !== d.label ? <span className="text-xs text-gray-500"> · {d.custom_name}</span> : null}</TableCell>
                                <TableCell className="text-xs text-gray-500">{d.value_type || '—'}</TableCell>
                                <TableCell className="text-right font-medium">
                                  {d.is_temperature && d.last_celsius != null ? fmtTemp(d.last_celsius)
                                    : d.value_type === 'bool' ? (d.last_value_raw ? 'Ligado / Sim' : 'Desligado / Não')
                                    : (d.last_value_text ?? d.last_value_raw ?? '—')}
                                </TableCell>
                                <TableCell className="whitespace-nowrap text-xs">{d.last_read_at ? fmtDateTime(d.last_read_at, true) : '—'}</TableCell>
                                <TableCell className="text-right text-xs">{Number(d.readings || 0).toLocaleString('pt-BR')}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Tabela */}
            <Card>
              <CardContent className="p-0">
                <div className="flex items-center justify-between px-4 py-3 border-b">
                  <h2 className="font-semibold text-gray-800 dark:text-gray-100">Leituras</h2>
                  <span className="text-xs text-gray-500">mostrando {Math.min(tableLimit, points.length).toLocaleString('pt-BR')} de {points.length.toLocaleString('pt-BR')} (mais recentes primeiro)</span>
                </div>
                <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-white dark:bg-gray-800 z-10">
                      <TableRow>
                        <TableHead>{isRaw ? 'Data/hora' : 'Início do intervalo'}</TableHead>
                        {!isRaw && <TableHead className="text-right">Leituras</TableHead>}
                        {isRaw ? (
                          <>
                            <TableHead className="text-right">{mainLabel}</TableHead>
                            <TableHead className="text-right">{evapLabel}</TableHead>
                          </>
                        ) : (
                          <>
                            <TableHead className="text-right">{mainLabel} mín</TableHead>
                            <TableHead className="text-right">{mainLabel} méd</TableHead>
                            <TableHead className="text-right">{mainLabel} máx</TableHead>
                            <TableHead className="text-right">{evapLabel} mín</TableHead>
                            <TableHead className="text-right">{evapLabel} méd</TableHead>
                            <TableHead className="text-right">{evapLabel} máx</TableHead>
                          </>
                        )}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {points.slice().reverse().slice(0, tableLimit).map((p) => (
                        <TableRow key={p.t}>
                          <TableCell className="whitespace-nowrap">{fmtDateTime(p.t, isRaw)}</TableCell>
                          {!isRaw && <TableCell className="text-right">{p.n}</TableCell>}
                          {isRaw ? (
                            <>
                              <TableCell className="text-right font-medium">{fmtTemp(p.main_avg)}</TableCell>
                              <TableCell className="text-right">{fmtTemp(p.evap_avg)}</TableCell>
                            </>
                          ) : (
                            <>
                              <TableCell className="text-right">{fmtTemp(p.main_min)}</TableCell>
                              <TableCell className="text-right font-medium">{fmtTemp(p.main_avg, 2)}</TableCell>
                              <TableCell className="text-right">{fmtTemp(p.main_max)}</TableCell>
                              <TableCell className="text-right">{fmtTemp(p.evap_min)}</TableCell>
                              <TableCell className="text-right">{fmtTemp(p.evap_avg, 2)}</TableCell>
                              <TableCell className="text-right">{fmtTemp(p.evap_max)}</TableCell>
                            </>
                          )}
                        </TableRow>
                      ))}
                      {!points.length && (
                        <TableRow><TableCell colSpan={isRaw ? 3 : 8} className="text-center text-sm text-gray-500 py-6">Sem leituras neste período.</TableCell></TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
                {points.length > tableLimit && (
                  <div className="p-3 border-t text-center">
                    <Button variant="outline" size="sm" onClick={() => setTableLimit((n) => n + 500)}>Mostrar mais 500</Button>
                    <span className="text-xs text-gray-500 ml-3">Para a lista completa use o CSV.</span>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
        <div className="text-lg font-semibold text-gray-900 dark:text-white truncate" title={value}>{value}</div>
        {sub && <div className="text-[11px] text-gray-500 truncate">{sub}</div>}
      </CardContent>
    </Card>
  );
}
