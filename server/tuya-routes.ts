// ============================================================================
// TEMPERATURAS TUYA — rotas /api/tuya/* (27/out/2026)
// Histórico de temperatura dos controladores Coel E34B lidos da nuvem Tuya pelo
// coletor (tuya-collector.ts, a cada 60 s). Tela: /temperaturas (Temperaturas.tsx).
//
// Auth: rota a rota (authenticateUser + requireRole(['admin'])) — perfil
// "industria" é promovido a admin no authenticateUser (17/ago).
// Tabelas SEM schema drizzle → SQL parametrizado (drizzle sql``).
//
//   GET  /api/tuya/status                       estado do coletor + config
//   GET  /api/tuya/devices[?refresh=1]          controladores (cache do banco; refresh relista na Tuya)
//   GET  /api/tuya/devices/:id/readings         ?from&to&bucket=raw|1m|1h|4h|8h|12h|24h[&main=code&evap=code]
//   GET  /api/tuya/devices/:id/readings.csv     mesmos parâmetros, CSV (; e vírgula decimal, horário BRT)
//   GET  /api/tuya/devices/:id/readings-all.csv ?from&to — TODOS os DPs gravados, formato longo (1 linha por DP/leitura)
//   GET  /api/tuya/devices/:id/dps              catálogo dos DPs do aparelho (tipo, nome, último valor)
//   GET  /api/tuya/devices/:id/latest           último valor gravado de cada DP
//   POST /api/tuya/collect-now                  dispara uma rodada do coletor agora
//   GET  /api/tuya/pasteurizacao/sensores|:orderId, POST .../:orderId/iniciar|finalizar  (tuya-pasteurizacao.ts)
//   GET  /api/tuya/alerta/preview               relatório WhatsApp montado (sem enviar) + destinos
//   POST /api/tuya/alerta/enviar-agora          envia o relatório WhatsApp agora
// ============================================================================
import type { Express, Request, Response } from 'express';
import { db } from './db';
import { sql } from 'drizzle-orm';
import { authenticateUser, requireRole } from './authMiddleware';
import { ensureTuyaTables, getTuyaCollectorState, refreshTuyaDevices, runTuyaCollector } from './tuya-collector';
import { isTuyaConfigured, tuyaTestConnection, TUYA_HOST, TUYA_ACCESS_ID, TUYA_TEMP_CODES, TUYA_STATUS_CODES, TUYA_DP_LABELS } from './tuya-service';
import { getSensorLabels, labelFor, ensurePasteurizacaoColumns, estadoPasteurizacao, iniciarPasteurizacao, finalizarPasteurizacao, resolverSensores } from './tuya-pasteurizacao';

const str = (v: any, max = 120): string | null => {
  if (v == null) return null;
  const s = String(v).trim().slice(0, max);
  return s === '' ? null : s;
};

// Intervalo entre pontos → segundos (raw = sem agregação, agrupado no segundo)
const BUCKETS: Record<string, number> = { raw: 0, '1m': 60, '1h': 3600, '4h': 4 * 3600, '8h': 8 * 3600, '12h': 12 * 3600, '24h': 24 * 3600 };
const RAW_MAX_POINTS = 60000;   // ~41 dias a 1 ponto/min; acima disso devolve truncated=true

const MAIN_CODE = 'temp_current';
const EVAP_CODE = 'temperatura_do_evaporador';
const CODE_RE = /^[a-zA-Z0-9_\-]{1,80}$/;

interface Period { from: Date; to: Date; bucket: string; secs: number; main: string; evap: string }

function parsePeriod(q: any): Period | { error: string } {
  const now = new Date();
  const to = q.to ? new Date(String(q.to)) : now;
  const from = q.from ? new Date(String(q.from)) : new Date(to.getTime() - 24 * 3600 * 1000);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return { error: 'from/to invalidos (use ISO 8601)' };
  if (from >= to) return { error: 'from deve ser anterior a to' };
  const bucket = String(q.bucket || 'raw').toLowerCase();
  if (!(bucket in BUCKETS)) return { error: 'bucket invalido', buckets: Object.keys(BUCKETS) } as any;
  // Séries do gráfico: por padrão sonda principal e evaporador do E34B; qualquer DP numérico pode ser pedido
  // (sensores novos) — valor = celsius quando é temperatura, senão value_raw.
  const main = String(q.main || MAIN_CODE);
  const evap = String(q.evap || EVAP_CODE);
  if (!CODE_RE.test(main) || !CODE_RE.test(evap)) return { error: 'codigo de DP invalido' };
  return { from, to, bucket, secs: BUCKETS[bucket], main, evap };
}

interface Point {
  t: string;                        // ISO (início do intervalo)
  n: number;                        // leituras brutas no intervalo (sonda principal)
  main_min: number | null; main_avg: number | null; main_max: number | null;
  evap_min: number | null; evap_avg: number | null; evap_max: number | null;
}

async function queryPoints(deviceId: string, p: Period): Promise<{ points: Point[]; truncated: boolean }> {
  const fromIso = p.from.toISOString();
  const toIso = p.to.toISOString();
  // raw: agrupa no segundo (sonda e evaporador do mesmo report têm o mesmo `time`,
  // mas se diferirem em ms ainda caem no mesmo ponto). Demais: piso do epoch no tamanho do balde.
  const bucketExpr = p.secs > 0
    ? sql`to_timestamp(floor(extract(epoch from read_at) / ${p.secs}::int) * ${p.secs}::int)`
    : sql`date_trunc('second', read_at)`;
  const limit = p.secs > 0 ? 100000 : RAW_MAX_POINTS + 1;
  const v = sql`COALESCE(celsius, value_raw::numeric)`;
  const r: any = await db.execute(sql`
    SELECT ${bucketExpr} AS t,
           COUNT(*) FILTER (WHERE code = ${p.main})::int        AS n,
           MIN(${v}) FILTER (WHERE code = ${p.main})            AS main_min,
           ROUND(AVG(${v}) FILTER (WHERE code = ${p.main}), 2)  AS main_avg,
           MAX(${v}) FILTER (WHERE code = ${p.main})            AS main_max,
           MIN(${v}) FILTER (WHERE code = ${p.evap})            AS evap_min,
           ROUND(AVG(${v}) FILTER (WHERE code = ${p.evap}), 2)  AS evap_avg,
           MAX(${v}) FILTER (WHERE code = ${p.evap})            AS evap_max
    FROM tuya_temperature_readings
    WHERE device_id = ${deviceId}
      AND code IN (${p.main}, ${p.evap})
      AND read_at >= ${fromIso}::timestamptz AND read_at < ${toIso}::timestamptz
    GROUP BY 1
    ORDER BY 1
    LIMIT ${limit}`);
  const rows: any[] = r.rows || [];
  const truncated = p.secs === 0 && rows.length > RAW_MAX_POINTS;
  const num = (v: any) => (v == null ? null : Number(v));
  const points: Point[] = (truncated ? rows.slice(0, RAW_MAX_POINTS) : rows).map((x) => ({
    t: new Date(x.t).toISOString(), n: Number(x.n) || 0,
    main_min: num(x.main_min), main_avg: num(x.main_avg), main_max: num(x.main_max),
    evap_min: num(x.evap_min), evap_avg: num(x.evap_avg), evap_max: num(x.evap_max),
  }));
  return { points, truncated };
}

async function loadDevice(deviceId: string): Promise<any | null> {
  const r: any = await db.execute(sql`SELECT device_id, name, product_name, category, online, last_seen_at, last_poll_at, last_error FROM tuya_devices WHERE device_id = ${deviceId} LIMIT 1`);
  return (r.rows || [])[0] || null;
}

const fmtBRT = (iso: string) => {
  // dd/mm/aaaa hh:mm:ss em America/Sao_Paulo (sem depender de lib)
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value || '';
  return `${g('day')}/${g('month')}/${g('year')} ${g('hour')}:${g('minute')}:${g('second')}`;
};
const fmtNum = (v: number | null) => (v == null ? '' : String(v).replace('.', ','));

export function registerTuyaRoutes(app: Express) {
  const guard = [authenticateUser, requireRole(['admin'])] as any[];

  // Garante as tabelas no boot (idempotente) — não bloqueia o start.
  ensureTuyaTables().catch((e) => console.error('[tuya] ensureTuyaTables:', e?.message || e));
  ensurePasteurizacaoColumns().catch((e) => console.error('[tuya] ensurePasteurizacaoColumns:', e?.message || e));

  // ------------------------------------------------------------ status
  app.get('/api/tuya/status', ...guard, async (req: Request, res: Response) => {
    try {
      const st = getTuyaCollectorState();
      let connection: any = undefined;
      if (String(req.query.test || '') === '1') connection = await tuyaTestConnection();
      const cnt: any = await db.execute(sql`SELECT COUNT(*)::bigint AS n, MIN(read_at) AS first_at, MAX(read_at) AS last_at FROM tuya_temperature_readings`).catch(() => ({ rows: [{}] }));
      const row = (cnt.rows || [])[0] || {};
      res.json({
        ...st, host: TUYA_HOST, accessId: TUYA_ACCESS_ID, configured: isTuyaConfigured(), connection,
        readings: { total: Number(row.n) || 0, first_at: row.first_at || null, last_at: row.last_at || null },
        codes: { temperaturas: TUYA_TEMP_CODES, status: TUYA_STATUS_CODES },
        pollSeconds: 60,
      });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // ------------------------------------------------------------ devices
  app.get('/api/tuya/devices', ...guard, async (req: Request, res: Response) => {
    try {
      await ensureTuyaTables();
      let refreshError: string | null = null;
      const wantRefresh = String(req.query.refresh || '') === '1';
      const cnt: any = await db.execute(sql`SELECT COUNT(*)::int AS n FROM tuya_devices`);
      const empty = (Number(cnt.rows?.[0]?.n) || 0) === 0;
      if ((wantRefresh || empty) && isTuyaConfigured()) {
        try { await refreshTuyaDevices(true); } catch (e: any) { refreshError = e?.message || String(e); }
      }
      const r: any = await db.execute(sql`
        SELECT d.device_id, d.name, d.product_name, d.category, d.online, d.first_seen_at, d.last_seen_at, d.last_poll_at, d.last_error,
               m.celsius  AS last_main_celsius,  m.read_at AS last_main_at,
               ev.celsius AS last_evap_celsius,  ev.read_at AS last_evap_at,
               (SELECT COUNT(*)::bigint FROM tuya_temperature_readings x WHERE x.device_id = d.device_id AND x.code = ${MAIN_CODE}) AS readings_main,
               (SELECT MIN(read_at) FROM tuya_temperature_readings x WHERE x.device_id = d.device_id) AS first_reading_at
        FROM tuya_devices d
        LEFT JOIN LATERAL (SELECT celsius, read_at FROM tuya_temperature_readings t WHERE t.device_id = d.device_id AND t.code = ${MAIN_CODE} ORDER BY read_at DESC LIMIT 1) m ON true
        LEFT JOIN LATERAL (SELECT celsius, read_at FROM tuya_temperature_readings t WHERE t.device_id = d.device_id AND t.code = ${EVAP_CODE} ORDER BY read_at DESC LIMIT 1) ev ON true
        ORDER BY d.online DESC, d.name`);
      const labels = await getSensorLabels();
      const devices = (r.rows || []).map((d: any) => ({
        ...d,
        last_main_celsius: d.last_main_celsius == null ? null : Number(d.last_main_celsius),
        last_evap_celsius: d.last_evap_celsius == null ? null : Number(d.last_evap_celsius),
        readings_main: Number(d.readings_main) || 0,
        // rótulos por aparelho (ex.: Banco de gelo → "Temperatura do Banco de gelo" / "Resfriamento da Pasteurização")
        main_label: labelFor(labels, d.name, MAIN_CODE).label,
        evap_label: labelFor(labels, d.name, EVAP_CODE).label,
      }));
      res.json({ total: devices.length, devices, configured: isTuyaConfigured(), refreshError, collector: getTuyaCollectorState() });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // ------------------------------------------------------------ readings (JSON)
  app.get('/api/tuya/devices/:id/readings', ...guard, async (req: Request, res: Response) => {
    try {
      const id = str(req.params.id, 80);
      if (!id) return res.status(400).json({ error: 'device id invalido' });
      const p = parsePeriod(req.query);
      if ('error' in p) return res.status(400).json(p);
      const device = await loadDevice(id);
      const labels = await getSensorLabels();
      const { points, truncated } = await queryPoints(id, p);
      // resumo do período (sobre os pontos devolvidos)
      const mains = points.filter((x) => x.main_avg != null);
      const summary = mains.length ? {
        main_min: Math.min(...mains.map((x) => x.main_min as number)),
        main_max: Math.max(...mains.map((x) => x.main_max as number)),
        main_avg: Number((mains.reduce((s, x) => s + (x.main_avg as number) * Math.max(1, x.n), 0) / mains.reduce((s, x) => s + Math.max(1, x.n), 0)).toFixed(2)),
        raw_count: mains.reduce((s, x) => s + x.n, 0),
      } : null;
      res.json({
        device: device || { device_id: id, name: id },
        from: p.from.toISOString(), to: p.to.toISOString(), bucket: p.bucket, bucketSeconds: p.secs,
        codes: (() => { const lb = (c: string) => labelFor(labels, device?.name || '', c); const lm = lb(p.main), le = lb(p.evap);
          return { main: p.main, evap: p.evap, main_label: lm.custom ? lm.label : (TUYA_DP_LABELS[p.main] || p.main), evap_label: le.custom ? le.label : (TUYA_DP_LABELS[p.evap] || p.evap) }; })(),
        total: points.length, truncated, summary, points,
      });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // ------------------------------------------------------------ readings (CSV)
  app.get('/api/tuya/devices/:id/readings.csv', ...guard, async (req: Request, res: Response) => {
    try {
      const id = str(req.params.id, 80);
      if (!id) return res.status(400).json({ error: 'device id invalido' });
      const p = parsePeriod(req.query);
      if ('error' in p) return res.status(400).json(p);
      const device = await loadDevice(id);
      const { points } = await queryPoints(id, p);
      const name = String(device?.name || id);
      const isRaw = p.secs === 0;
      const head = isRaw
        ? ['data_hora', 'sonda_principal_c', 'evaporador_c']
        : ['intervalo_inicio', 'leituras', 'sonda_min_c', 'sonda_media_c', 'sonda_max_c', 'evap_min_c', 'evap_media_c', 'evap_max_c'];
      const lines = [
        `# controlador;${name};${id}`,
        `# periodo;${fmtBRT(p.from.toISOString())};${fmtBRT(p.to.toISOString())};intervalo=${p.bucket}`,
        head.join(';'),
      ];
      for (const x of points) {
        lines.push(isRaw
          ? [fmtBRT(x.t), fmtNum(x.main_avg), fmtNum(x.evap_avg)].join(';')
          : [fmtBRT(x.t), String(x.n), fmtNum(x.main_min), fmtNum(x.main_avg), fmtNum(x.main_max), fmtNum(x.evap_min), fmtNum(x.evap_avg), fmtNum(x.evap_max)].join(';'));
      }
      const safe = name.replace(/[^\w\-]+/g, '_').slice(0, 40);
      const stamp = p.from.toISOString().slice(0, 10) + '_' + p.to.toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="temperaturas_${safe}_${stamp}_${p.bucket}.csv"`);
      res.send('﻿' + lines.join('\r\n') + '\r\n');   // BOM p/ Excel abrir com acentos
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // ------------------------------------------------------------ CSV com TODOS os DPs (formato longo)
  app.get('/api/tuya/devices/:id/readings-all.csv', ...guard, async (req: Request, res: Response) => {
    try {
      const id = str(req.params.id, 80);
      if (!id) return res.status(400).json({ error: 'device id invalido' });
      const p = parsePeriod(req.query);
      if ('error' in p) return res.status(400).json(p);
      const device = await loadDevice(id);
      const r: any = await db.execute(sql`
        SELECT read_at, code, dp_id, value_type, value_raw, value_text, celsius, collected_at
        FROM tuya_temperature_readings
        WHERE device_id = ${id} AND read_at >= ${p.from.toISOString()}::timestamptz AND read_at < ${p.to.toISOString()}::timestamptz
        ORDER BY read_at, code
        LIMIT 500000`);
      const rows: any[] = r.rows || [];
      const name = String(device?.name || id);
      const lines = [
        `# controlador;${name};${id}`,
        `# periodo;${fmtBRT(p.from.toISOString())};${fmtBRT(p.to.toISOString())};todos_os_dps;linhas=${rows.length}${rows.length >= 500000 ? ';TRUNCADO' : ''}`,
        'data_hora;code;descricao;dp_id;tipo;valor_bruto;valor_texto;celsius;coletado_em',
      ];
      const esc = (t: any) => { const s = t == null ? '' : String(t); return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      for (const x of rows) {
        lines.push([fmtBRT(new Date(x.read_at).toISOString()), x.code, TUYA_DP_LABELS[x.code] || '', x.dp_id ?? '', x.value_type ?? '',
          x.value_raw ?? '', esc(x.value_text), fmtNum(x.celsius == null ? null : Number(x.celsius)), fmtBRT(new Date(x.collected_at).toISOString())].join(';'));
      }
      const safe = name.replace(/[^\w\-]+/g, '_').slice(0, 40);
      const stamp = p.from.toISOString().slice(0, 10) + '_' + p.to.toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="tuya_todos_dps_${safe}_${stamp}.csv"`);
      res.send('\ufeff' + lines.join('\r\n') + '\r\n');
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // ------------------------------------------------------------ catálogo de DPs do aparelho
  app.get('/api/tuya/devices/:id/dps', ...guard, async (req: Request, res: Response) => {
    try {
      const id = str(req.params.id, 80);
      if (!id) return res.status(400).json({ error: 'device id invalido' });
      await ensureTuyaTables();
      const r: any = await db.execute(sql`
        SELECT c.*, (SELECT COUNT(*)::bigint FROM tuya_temperature_readings x WHERE x.device_id = c.device_id AND x.code = c.code) AS readings
        FROM tuya_device_dps c WHERE c.device_id = ${id} ORDER BY c.dp_id NULLS LAST, c.code`);
      res.json({ device_id: id, total: (r.rows || []).length, dps: (r.rows || []).map((x: any) => ({
        ...x, label: TUYA_DP_LABELS[x.code] || x.custom_name || x.code,
        last_celsius: x.last_celsius == null ? null : Number(x.last_celsius), readings: Number(x.readings) || 0,
      })) });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // ------------------------------------------------------------ último valor de cada DP gravado
  app.get('/api/tuya/devices/:id/latest', ...guard, async (req: Request, res: Response) => {
    try {
      const id = str(req.params.id, 80);
      if (!id) return res.status(400).json({ error: 'device id invalido' });
      const r: any = await db.execute(sql`
        SELECT DISTINCT ON (code) code, dp_id, value_type, value_raw, value_text, celsius, read_at, collected_at
        FROM tuya_temperature_readings WHERE device_id = ${id}
        ORDER BY code, read_at DESC`);
      res.json({ device_id: id, dps: (r.rows || []).map((x: any) => ({ ...x, label: TUYA_DP_LABELS[x.code] || x.code, celsius: x.celsius == null ? null : Number(x.celsius) })) });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // ------------------------------------------------------------ relatório WhatsApp (tuya-alerta.ts)
  // GET  /api/tuya/alerta/preview      → mensagem montada + destinos resolvidos (não envia)
  // POST /api/tuya/alerta/enviar-agora → envia agora (ignora kill-switch/anti-duplicata)
  app.get('/api/tuya/alerta/preview', ...guard, async (_req: Request, res: Response) => {
    try {
      const { lerCamaras, montarMensagem, resolverDestinos } = await import('./tuya-alerta');
      const camaras = await lerCamaras();
      const last: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'tuya_alerta_last' LIMIT 1`);
      const ativo: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'tuya_alerta_ativo' LIMIT 1`);
      res.json({ mensagem: montarMensagem(camaras, new Date(), await getSensorLabels()), camaras: camaras.length, destinos: await resolverDestinos(),
        ultimoEnvio: last.rows?.[0]?.value || null, ativo: (ativo.rows?.[0]?.value || 'on') !== 'off', horarios: '07h, 09h, 11h, 13h, 15h, 17h, 19h, 21h (BRT, todos os dias)' });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  app.post('/api/tuya/alerta/enviar-agora', ...guard, async (req: Request, res: Response) => {
    try {
      const { enviarRelatorioTemperaturas } = await import('./tuya-alerta');
      const r = await enviarRelatorioTemperaturas({ force: true, origem: 'manual:' + (str((req as any).currentUser?.email, 80) || 'admin') });
      res.json({ ok: r.enviado, ...r });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // ------------------------------------------------------------ pasteurização nas OPs (tuya-pasteurizacao.ts)
  // GET  /api/tuya/pasteurizacao/sensores            sensores configurados + se o aparelho já existe/online
  // GET  /api/tuya/pasteurizacao/:orderId            estado (snapshot ou séries ao vivo)
  // POST /api/tuya/pasteurizacao/:orderId/iniciar    body { reiniciar?: true }
  // POST /api/tuya/pasteurizacao/:orderId/finalizar
  const userOf = (req: any) => str((req as any).currentUser?.email || (req as any).currentUser?.id, 120) || 'admin-2.0';
  app.get('/api/tuya/pasteurizacao/sensores', ...guard, async (_req: Request, res: Response) => {
    try { res.json({ sensores: await resolverSensores() }); }
    catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  app.get('/api/tuya/pasteurizacao/:orderId', ...guard, async (req: Request, res: Response) => {
    try {
      const id = str(req.params.orderId, 80);
      if (!id) return res.status(400).json({ error: 'ordem invalida' });
      const st = await estadoPasteurizacao(id);
      if (!st) return res.status(404).json({ error: 'ordem nao encontrada' });
      res.json(st);
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  app.post('/api/tuya/pasteurizacao/:orderId/iniciar', ...guard, async (req: Request, res: Response) => {
    try {
      const id = str(req.params.orderId, 80);
      if (!id) return res.status(400).json({ error: 'ordem invalida' });
      res.json({ ok: true, ...(await iniciarPasteurizacao(id, userOf(req), (req.body || {}).reiniciar === true)) });
    } catch (e: any) { res.status(e?.status || 500).json({ error: e?.message || String(e) }); }
  });
  app.post('/api/tuya/pasteurizacao/:orderId/finalizar', ...guard, async (req: Request, res: Response) => {
    try {
      const id = str(req.params.orderId, 80);
      if (!id) return res.status(400).json({ error: 'ordem invalida' });
      res.json({ ok: true, ...(await finalizarPasteurizacao(id, userOf(req))) });
    } catch (e: any) { res.status(e?.status || 500).json({ error: e?.message || String(e) }); }
  });

  // ------------------------------------------------------------ rodada manual
  app.post('/api/tuya/collect-now', ...guard, async (_req: Request, res: Response) => {
    try {
      if (!isTuyaConfigured()) return res.status(400).json({ error: 'TUYA_ACCESS_SECRET nao configurado no ambiente' });
      const st = await runTuyaCollector({ forceDeviceRefresh: true });
      res.json({ ok: st.errors.length === 0, ...st });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  console.log('🌡️ [TUYA] rotas /api/tuya/* registradas' + (isTuyaConfigured() ? '' : ' (TUYA_ACCESS_SECRET ausente — coletor inativo)'));
}
