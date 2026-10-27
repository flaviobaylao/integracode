// ============================================================================
// TUYA CLOUD — cliente da OpenAPI v2 (27/out/2026)
// Usado pelo coletor de temperaturas dos controladores Coel E34B (app Smart Life
// vinculado ao projeto "Integra Honest", Western America Data Center).
//
// Assinatura validada em tuya-teste.mjs (26–27/out):
//   token : GET /v1.0/token?grant_type=1
//   sign  : HMAC-SHA256(client_id + [access_token] + t + method + "\n" +
//           sha256(body) + "\n\n" + path, secret) em MAIÚSCULAS
//   token expira em 2 h → renovado sozinho (e em qualquer erro de token).
//
// Variáveis de ambiente (Railway):
//   TUYA_ACCESS_ID      (Access ID/Client ID do projeto — default do "Integra Honest")
//   TUYA_ACCESS_SECRET  (Access Secret — aba Overview do projeto; OBRIGATÓRIA)
//   TUYA_HOST           (default https://openapi.tuyaus.com — Western America)
//
// Sem dependências: fetch + crypto nativos do Node 18+.
// ============================================================================
import crypto from 'node:crypto';

const ACCESS_ID = process.env.TUYA_ACCESS_ID || '5vvktyekp3gfm4e47tve';
const ACCESS_SECRET = process.env.TUYA_ACCESS_SECRET || '';
const HOST = (process.env.TUYA_HOST || 'https://openapi.tuyaus.com').replace(/\/+$/, '');

export const TUYA_HOST = HOST;
export const TUYA_ACCESS_ID = ACCESS_ID;

/** Código Tuya quando a assinatura do IoT Core (trial) venceu — renovar em Cloud › Service API › IoT Core › Extend Trial. */
export const TUYA_CODE_TRIAL_EXPIRED = 28841002;
/** Códigos de token inválido/expirado — basta relogar. */
const TOKEN_ERROR_CODES = new Set([1010, 1011, 1012, 1013, 1004]);

export class TuyaError extends Error {
  code: number;
  path: string;
  constructor(path: string, code: number, msg: string) {
    super(`Tuya ${path}: code=${code} msg=${msg}`);
    this.name = 'TuyaError';
    this.code = code;
    this.path = path;
  }
  get isTokenError() { return TOKEN_ERROR_CODES.has(this.code); }
  get isTrialExpired() { return this.code === TUYA_CODE_TRIAL_EXPIRED; }
}

export function isTuyaConfigured(): boolean {
  return Boolean(ACCESS_ID && ACCESS_SECRET);
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (s: string) => crypto.createHmac('sha256', ACCESS_SECRET).update(s, 'utf8').digest('hex').toUpperCase();

let token: string | null = null;
let tokenExpiresAt = 0;          // epoch ms
let loginPromise: Promise<void> | null = null;

async function rawCall(method: 'GET' | 'POST', path: string, body?: any): Promise<any> {
  const t = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const stringToSign = [method, sha256(bodyStr), '', path].join('\n');
  const isToken = path.startsWith('/v1.0/token');
  const sign = hmac(ACCESS_ID + (isToken ? '' : (token || '')) + t + stringToSign);
  const headers: Record<string, string> = {
    client_id: ACCESS_ID, sign, t, sign_method: 'HMAC-SHA256', 'Content-Type': 'application/json',
  };
  if (!isToken && token) headers.access_token = token;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(HOST + path, { method, headers, body: bodyStr || undefined, signal: ctrl.signal });
    const j: any = await r.json().catch(() => ({}));
    if (!j || j.success !== true) throw new TuyaError(path, Number(j?.code) || r.status, String(j?.msg || r.statusText || 'erro'));
    return j.result;
  } finally { clearTimeout(timer); }
}

async function login(): Promise<void> {
  if (!isTuyaConfigured()) throw new Error('TUYA_ACCESS_SECRET nao configurado no ambiente');
  if (loginPromise) return loginPromise;           // evita N logins simultâneos
  loginPromise = (async () => {
    token = null;
    const r = await rawCall('GET', '/v1.0/token?grant_type=1');
    token = String(r.access_token);
    // expire_time vem em segundos (7200). Renova 5 min antes.
    const ttl = (Number(r.expire_time) || 7200) * 1000;
    tokenExpiresAt = Date.now() + Math.max(60_000, ttl - 5 * 60_000);
  })();
  try { await loginPromise; } finally { loginPromise = null; }
}

/** Chamada autenticada; renova o token quando faltar/expirar e repete 1x em erro de token. */
export async function tuyaCall(method: 'GET' | 'POST', path: string, body?: any): Promise<any> {
  if (!token || Date.now() >= tokenExpiresAt) await login();
  try {
    return await rawCall(method, path, body);
  } catch (e: any) {
    if (e instanceof TuyaError && e.isTokenError) {
      await login();
      return await rawCall(method, path, body);
    }
    throw e;
  }
}

/** Força novo token (útil para testar credenciais). */
export async function tuyaTestConnection(): Promise<{ ok: boolean; host: string; accessId: string; error?: string }> {
  try { await login(); return { ok: true, host: HOST, accessId: ACCESS_ID }; }
  catch (e: any) { return { ok: false, host: HOST, accessId: ACCESS_ID, error: e?.message || String(e) }; }
}

// ---------------------------------------------------------------------------
// Dispositivos e DPs
// ---------------------------------------------------------------------------
export interface TuyaDevice {
  id: string;
  name: string;
  category: string | null;
  product_name: string | null;
  product_id: string | null;
  online: boolean;
  uid: string | null;
  ip: string | null;
  update_time: number | null;   // epoch s (como a Tuya devolve)
}

/** Lista TODOS os dispositivos das contas de app vinculadas ao projeto (pagina pelo last_row_key). */
export async function tuyaListDevices(): Promise<TuyaDevice[]> {
  const out: TuyaDevice[] = [];
  let lastRowKey: string | null = null;
  for (let page = 0; page < 20; page++) {
    const qs = `size=100${lastRowKey ? `&last_row_key=${encodeURIComponent(lastRowKey)}` : ''}`;
    const r: any = await tuyaCall('GET', `/v1.0/iot-01/associated-users/devices?${qs}`);
    for (const d of (r?.devices || [])) {
      out.push({
        id: String(d.id),
        name: String(d.name || d.id),
        category: d.category ?? null,
        product_name: d.product_name ?? null,
        product_id: d.product_id ?? null,
        online: d.online === true,
        uid: d.uid ?? null,
        ip: d.ip ?? null,
        update_time: d.update_time != null ? Number(d.update_time) : null,
      });
    }
    if (!r?.has_more || !r?.last_row_key) break;
    lastRowKey = String(r.last_row_key);
  }
  return out;
}

export interface TuyaProperty {
  code: string;
  dp_id: number;
  value: any;
  time: number;      // epoch ms da última atualização do DP (carimbo do aparelho)
  type?: string;     // value | bool | enum | string | bitmap | raw | json
  custom_name?: string | null;
}

/** Todos os DPs atuais do aparelho (38 no E34B), cada um com o `time` da última atualização. */
export async function tuyaShadowProperties(deviceId: string): Promise<TuyaProperty[]> {
  const r: any = await tuyaCall('GET', `/v2.0/cloud/thing/${encodeURIComponent(deviceId)}/shadow/properties`);
  return (r?.properties || []).map((p: any) => ({
    code: String(p.code), dp_id: Number(p.dp_id), value: p.value, time: Number(p.time) || Date.now(),
    type: p.type != null ? String(p.type) : undefined, custom_name: p.custom_name ?? null,
  }));
}

// ---------------------------------------------------------------------------
// DPs — gravamos TODOS (pedido Flavio 27/out: "todos os dados possíveis", novos
// sensores e atribuições virão). Só o que é temperatura ganha `celsius`.
//
// Mapa dos DPs do Coel E34B (Tuya_Coel_Plano_de_Testes_INTEGRA20.md):
// temperaturas vêm inteiras ×10 (129 = 12,9 °C).
// Para sensores novos com outros códigos/escala: env TUYA_TEMP_CODES, formato
// "code[:divisor],code[:divisor]" (ex.: "temp_indoor:10,temp_1:1") — soma-se ao default.
// ---------------------------------------------------------------------------
export const TUYA_TEMP_CODES: Record<string, string> = {
  temp_current: 'Sonda principal',
  temperatura_do_evaporador: 'Evaporador',
  temperatura_minima_lida: 'Mínima lida (controlador)',
  temperatura_maxima_lida: 'Máxima lida (controlador)',
  temp_set: 'Setpoint',
};
/** Rótulos amigáveis dos demais DPs conhecidos do E34B (só para exibição). */
export const TUYA_STATUS_CODES: Record<string, string> = {
  status_do_compressor: 'Compressor',
  status_do_ventilador: 'Ventilador',
  status_da_porta: 'Porta',
  status_e_ativacao_degelo: 'Degelo',
  tempo_para_proximo_degelo: 'Próximo degelo (min)',
  status_do_alarme_hi: 'Alarme HI',
  status_do_alarme_lo: 'Alarme LO',
  status_alarme_porta: 'Alarme porta',
  alarme_falhas: 'Falhas (bitmap)',
  voltage_measurement: 'Tensão (V)',
  total_horas_geral: 'Horímetro (h)',
  mode: 'Modo',
  reset_temperatura_min_max: 'Reset mín/máx',
};
export const TUYA_DP_LABELS: Record<string, string> = { ...TUYA_TEMP_CODES, ...TUYA_STATUS_CODES };

const tempDivisor: Record<string, number> = Object.fromEntries(Object.keys(TUYA_TEMP_CODES).map((c) => [c, 10]));
for (const part of String(process.env.TUYA_TEMP_CODES || '').split(',')) {
  const [code, div] = part.trim().split(':');
  if (code) tempDivisor[code] = Math.max(1, Number(div) || 10);
}
/** Divisor p/ °C do código, ou null se não é temperatura. Heurística p/ códigos novos: nome com temp/temperatur + tipo numérico → ×10 (padrão Tuya). */
export function tuyaTempDivisor(code: string, type?: string): number | null {
  if (code in tempDivisor) return tempDivisor[code];
  if ((type == null || type === 'value') && /temp|temperatur/i.test(code) && !/time|tempo|hora/i.test(code)) return 10;
  return null;
}

export interface TuyaValueParts { raw: number | null; text: string; celsius: number | null }
/** Decompõe o valor de um DP: inteiro (bool→0/1, número truncado), texto sempre (JSON p/ objetos) e °C quando é temperatura. */
export function tuyaValueParts(code: string, value: any, type?: string): TuyaValueParts {
  let raw: number | null = null;
  if (typeof value === 'boolean') raw = value ? 1 : 0;
  else if (typeof value === 'number' && isFinite(value)) raw = Math.trunc(value);
  else if (typeof value === 'string' && value.trim() !== '' && isFinite(Number(value))) raw = Math.trunc(Number(value));
  const text = value == null ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value)).slice(0, 2000);
  const div = tuyaTempDivisor(code, type);
  const celsius = div != null && raw != null ? raw / div : null;
  return { raw, text, celsius };
}
