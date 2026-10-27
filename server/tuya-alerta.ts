// ============================================================================
// RELATÓRIO DE TEMPERATURAS POR WHATSAPP (27/out/2026) — pedido do Flavio
// A cada 2 horas, das 07h às 22h (BRT), TODOS os dias (sáb/dom/feriados incluídos),
// envia para Flavio e Naiara a temperatura atual de TODAS as câmaras/controladores
// Tuya — os que já existem e os que forem pareados depois (lê tuya_devices, sem
// cadastro manual). Cron em scheduler.ts: '0 7-22/2 * * *' (07,09,…,21) +
// 22h (ver lá). Também exposto em POST /api/tuya/alerta/enviar-agora.
//
// Configuração (system_settings, todas opcionais):
//   tuya_alerta_ativo     'on' (padrão) | 'off'            — kill-switch
//   tuya_alerta_destinos  'flavio,naiara' (padrão)          — keys dos destinos dos Chamados
//                         (getDestinos() → users.phone), OU números diretos separados por vírgula
//   tuya_alerta_numeros   números extras (vírgula) somados aos destinos
// Fonte dos dados: tuya_devices + último temp_current/evaporador de cada aparelho
// (tuya_temperature_readings). Aparelho sem leitura há >15 min é marcado "sem sinal".
// Anti-duplicata: system_settings 'tuya_alerta_last' guarda a hora do último envio;
// não reenvia dentro de 100 min (protege contra restart do servidor no mesmo slot).
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

const rows = (r: any): any[] => (r?.rows || []);

async function getSetting(key: string): Promise<string | null> {
  const r = rows(await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`));
  return r[0]?.value != null ? String(r[0].value) : null;
}
async function setSetting(key: string, value: string) {
  await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES (${key}, ${value}, 'scheduler')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
}

const fmtTemp = (v: any) => (v == null ? '—' : `${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} °C`);
const fmtHora = (d: Date) => d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
const fmtData = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

/** Resolve telefones: keys dos Chamados (flavio, naiara…) → users.phone; ou números diretos. */
export async function resolverDestinos(): Promise<string[]> {
  const cfg = (await getSetting('tuya_alerta_destinos')) || 'flavio,naiara';
  const extras = (await getSetting('tuya_alerta_numeros')) || '';
  const itens = `${cfg},${extras}`.split(',').map((s) => s.trim()).filter(Boolean);
  const fones = new Set<string>();
  const keys: string[] = [];
  for (const it of itens) {
    const d = it.replace(/\D/g, '');
    if (d.length >= 10 && d.length === it.replace(/[\s()+-]/g, '').length) fones.add(d.startsWith('55') ? d : '55' + d);
    else keys.push(it.toLowerCase());
  }
  if (keys.length) {
    try {
      const { getDestinos } = await import('./chamados-routes');
      const dest = await getDestinos();
      const ids = new Set<string>();
      for (const d of dest) if (keys.includes(String(d.key).toLowerCase())) for (const id of d.userIds || []) ids.add(String(id));
      if (ids.size) {
        const us = rows(await db.execute(sql`SELECT id, phone FROM users WHERE id IN (${sql.join(Array.from(ids).map((i) => sql`${i}`), sql`, `)})`));
        for (const u of us) {
          const f = String(u.phone || '').replace(/\D/g, '');
          if (f.length >= 10) fones.add(f.startsWith('55') ? f : '55' + f);
        }
      }
    } catch (e: any) { console.warn('[TUYA-ALERTA] getDestinos falhou:', e?.message || e); }
  }
  return Array.from(fones);
}

export interface LinhaCamara {
  device_id: string; name: string; online: boolean;
  main: number | null; main_at: Date | null; evap: number | null; setpoint: number | null;
  porta: boolean | null; compressor: boolean | null; alarme_hi: boolean | null; alarme_lo: boolean | null;
}

/** Última leitura de cada câmara (todos os aparelhos conhecidos, online ou não). */
export async function lerCamaras(): Promise<LinhaCamara[]> {
  const r = rows(await db.execute(sql`
    SELECT d.device_id, d.name, d.online,
           m.celsius AS main, m.read_at AS main_at,
           ev.celsius AS evap, sp.celsius AS setpoint,
           po.value_raw AS porta, co.value_raw AS compressor, hi.value_raw AS alarme_hi, lo.value_raw AS alarme_lo
    FROM tuya_devices d
    LEFT JOIN LATERAL (SELECT celsius, read_at FROM tuya_temperature_readings t WHERE t.device_id = d.device_id AND t.code = 'temp_current' ORDER BY read_at DESC LIMIT 1) m ON true
    LEFT JOIN LATERAL (SELECT celsius FROM tuya_temperature_readings t WHERE t.device_id = d.device_id AND t.code = 'temperatura_do_evaporador' ORDER BY read_at DESC LIMIT 1) ev ON true
    LEFT JOIN LATERAL (SELECT celsius FROM tuya_temperature_readings t WHERE t.device_id = d.device_id AND t.code = 'temp_set' ORDER BY read_at DESC LIMIT 1) sp ON true
    LEFT JOIN LATERAL (SELECT value_raw FROM tuya_temperature_readings t WHERE t.device_id = d.device_id AND t.code = 'status_da_porta' ORDER BY read_at DESC LIMIT 1) po ON true
    LEFT JOIN LATERAL (SELECT value_raw FROM tuya_temperature_readings t WHERE t.device_id = d.device_id AND t.code = 'status_do_compressor' ORDER BY read_at DESC LIMIT 1) co ON true
    LEFT JOIN LATERAL (SELECT value_raw FROM tuya_temperature_readings t WHERE t.device_id = d.device_id AND t.code = 'status_do_alarme_hi' ORDER BY read_at DESC LIMIT 1) hi ON true
    LEFT JOIN LATERAL (SELECT value_raw FROM tuya_temperature_readings t WHERE t.device_id = d.device_id AND t.code = 'status_do_alarme_lo' ORDER BY read_at DESC LIMIT 1) lo ON true
    ORDER BY d.name`));
  const b = (v: any) => (v == null ? null : Number(v) === 1);
  const n = (v: any) => (v == null ? null : Number(v));
  return r.map((x) => ({
    device_id: x.device_id, name: x.name, online: x.online === true,
    main: n(x.main), main_at: x.main_at ? new Date(x.main_at) : null, evap: n(x.evap), setpoint: n(x.setpoint),
    porta: b(x.porta), compressor: b(x.compressor), alarme_hi: b(x.alarme_hi), alarme_lo: b(x.alarme_lo),
  }));
}

export function montarMensagem(camaras: LinhaCamara[], agora = new Date()): string {
  const linhas: string[] = [];
  linhas.push(`🌡️ *Temperaturas das câmaras* — ${fmtData(agora)} ${fmtHora(agora)}`);
  linhas.push('');
  if (!camaras.length) linhas.push('Nenhum controlador Tuya vinculado ao projeto.');
  for (const c of camaras) {
    const idadeMin = c.main_at ? (agora.getTime() - c.main_at.getTime()) / 60000 : Infinity;
    const semSinal = !c.online || idadeMin > 15;
    const icone = semSinal ? '⚠️' : (c.alarme_hi || c.alarme_lo) ? '🚨' : '✅';
    let l = `${icone} *${c.name}*: ${fmtTemp(c.main)}`;
    if (c.evap != null) l += ` (evap. ${fmtTemp(c.evap)})`;
    if (c.setpoint != null) l += ` · set ${fmtTemp(c.setpoint)}`;
    const avisos: string[] = [];
    if (!c.online) avisos.push('OFFLINE');
    else if (idadeMin > 15 && isFinite(idadeMin)) avisos.push(`sem leitura há ${Math.round(idadeMin)} min`);
    else if (!c.main_at) avisos.push('sem leitura');
    if (c.alarme_hi) avisos.push('ALARME ALTA');
    if (c.alarme_lo) avisos.push('ALARME BAIXA');
    if (c.porta) avisos.push('porta aberta');
    if (avisos.length) l += ` — ${avisos.join(', ')}`;
    if (c.main_at && !semSinal) l += ` _(${fmtHora(c.main_at)})_`;
    linhas.push(l);
  }
  linhas.push('');
  linhas.push('Histórico: Integra › Indústria › Temperaturas');
  return linhas.join('\n');
}

export interface ResultadoEnvio { enviado: boolean; motivo?: string; destinos: string[]; enviados: number; falhas: string[]; mensagem: string }

/** Monta e envia. `force` ignora kill-switch/anti-duplicata (botão "enviar agora"). */
export async function enviarRelatorioTemperaturas(opts: { force?: boolean; origem?: string } = {}): Promise<ResultadoEnvio> {
  const agora = new Date();
  const camaras = await lerCamaras();
  const mensagem = montarMensagem(camaras, agora);
  const base: ResultadoEnvio = { enviado: false, destinos: [], enviados: 0, falhas: [], mensagem };
  if (!opts.force) {
    if ((await getSetting('tuya_alerta_ativo')) === 'off') return { ...base, motivo: 'desligado (tuya_alerta_ativo=off)' };
    const last = await getSetting('tuya_alerta_last');
    if (last) {
      const at = new Date(last.slice(0, 24)).getTime();
      if (at && agora.getTime() - at < 100 * 60 * 1000) return { ...base, motivo: `já enviado há ${Math.round((agora.getTime() - at) / 60000)} min` };
    }
  }
  const destinos = await resolverDestinos();
  if (!destinos.length) {
    console.warn('[TUYA-ALERTA] nenhum destino com telefone (tuya_alerta_destinos / users.phone)');
    return { ...base, destinos, motivo: 'nenhum destino com telefone' };
  }
  const { enviarInterno } = await import('./envio-texto');
  const falhas: string[] = [];
  let enviados = 0;
  for (const tel of destinos) {
    try {
      const r = await enviarInterno(tel, mensagem);
      if (r.success) enviados++; else falhas.push(`${tel}: ${r.error || 'falha'}`);
    } catch (e: any) { falhas.push(`${tel}: ${e?.message || e}`); }
  }
  const reg = `${agora.toISOString()} origem=${opts.origem || 'cron'} enviados=${enviados}/${destinos.length}${falhas.length ? ' falhas=' + falhas.join('; ').slice(0, 200) : ''}`;
  await setSetting('tuya_alerta_last', reg).catch(() => {});
  console.log(`🌡️📲 [TUYA-ALERTA] ${camaras.length} câmara(s) → ${enviados}/${destinos.length} WhatsApp enviados${falhas.length ? ' · falhas: ' + falhas.join('; ') : ''}`);
  return { enviado: enviados > 0, destinos, enviados, falhas, mensagem };
}
