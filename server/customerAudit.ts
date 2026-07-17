import { db } from './db';
import { sql } from 'drizzle-orm';

/**
 * Auditoria de alterações de cliente (rezoneamento, periodicidade, dias de visita, etc.).
 * A tabela é criada sob demanda (CREATE TABLE IF NOT EXISTS) — não requer migração manual.
 * O histórico é gravado a partir de agora; alterações anteriores não existiam registradas.
 */

let __ensured = false;
export async function ensureCustomerAuditTable(): Promise<void> {
  if (__ensured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS customer_change_history (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id varchar NOT NULL,
      field varchar NOT NULL,
      label varchar NOT NULL,
      old_value text,
      new_value text,
      changed_by_user_id varchar,
      changed_by_name varchar,
      source varchar,
      created_at timestamptz DEFAULT now()
    )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_cch_customer_created ON customer_change_history (customer_id, created_at DESC)`);
  __ensured = true;
}

// Rótulos amigáveis (pt-BR) por campo. Somente campos aqui são auditados (evita ruído de chaves internas).
const LABELS: Record<string, string> = {
  name: 'Nome',
  companyName: 'Razão social',
  fantasyName: 'Nome fantasia',
  cpf: 'CPF',
  cnpj: 'CNPJ',
  segmentoPrincipal: 'Segmento',
  phone: 'Telefone',
  contact: 'Contato',
  email: 'E-mail',
  address: 'Endereço',
  city: 'Cidade',
  neighborhood: 'Bairro',
  state: 'UF',
  zipCode: 'CEP',
  route: 'Rota',
  sellerId: 'Vendedor (rezoneamento)',
  weekdays: 'Dias de visita',
  visitPeriodicity: 'Periodicidade',
  isActive: 'Ativo',
  virtualService: 'Atendimento virtual',
  isLead: 'Lead',
  isConsumerClient: 'Cliente consumidor',
  serviceStartDate: 'Início do fornecimento',
  exclusiveVehicle: 'Veículo exclusivo',
  vehicleTypes: 'Tipos de veículo',
  receivingWeekdays: 'Dias de recebimento',
  deliveryWeekdays: 'Dias de entrega',
  deliveryTimeSlots: 'Horários de recebimento',
  deliverySaturdayTimeSlots: 'Horários de recebimento (sáb)',
  omieStatus: 'Status Omie',
  situacao: 'Situação',
  omieInstanceId: 'Empresa emissora (instância)',
  icmsCsosn: 'CSOSN',
  stateRegistration: 'Inscrição estadual',
  isSupplier: 'Fornecedor',
  paymentMethod: 'Forma de pagamento',
  boletoDays: 'Dias de boleto',
  collectionDiscount: 'Desconto de cobrança',
  paymentInstallments: 'Parcelas',
  averageDeliveryTime: 'Tempo médio de entrega',
};

const BOOL_FIELDS = new Set(['isActive', 'virtualService', 'isLead', 'isConsumerClient', 'exclusiveVehicle', 'isSupplier']);
const JSON_FIELDS = new Set(['weekdays', 'receivingWeekdays', 'vehicleTypes', 'deliveryTimeSlots', 'deliverySaturdayTimeSlots', 'deliveryWeekdays']);
const DATE_FIELDS = new Set(['serviceStartDate']);

function toArray(v: any): any {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('[')) { try { return JSON.parse(t); } catch { /* noop */ } }
    if (t.includes(',')) return t.split(',').map((x) => x.trim()).filter(Boolean);
    return t ? [t] : [];
  }
  return v == null ? [] : [v];
}

// Valor canônico para COMPARAÇÃO (detecta mudança real).
function canon(field: string, v: any): string {
  if (v === null || v === undefined) return '';
  if (BOOL_FIELDS.has(field)) return (v === true || v === 'true' || v === 't' || v === 1 || v === '1') ? '1' : '0';
  if (DATE_FIELDS.has(field)) { const d = new Date(v as any); return isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10); }
  if (JSON_FIELDS.has(field)) return JSON.stringify(toArray(v));
  return String(v).trim();
}

// Valor formatado para EXIBIÇÃO (de/para).
function fmt(field: string, v: any): string {
  if (v === null || v === undefined || v === '') return '—';
  if (BOOL_FIELDS.has(field)) return (v === true || v === 'true' || v === 't' || v === 1 || v === '1') ? 'Sim' : 'Não';
  if (DATE_FIELDS.has(field)) { const d = new Date(v as any); return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('pt-BR'); }
  if (JSON_FIELDS.has(field)) { const a = toArray(v); return Array.isArray(a) && a.length ? a.join(', ') : '—'; }
  return String(v);
}

async function resolveUserNames(ids: string[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const uniq = Array.from(new Set(ids.filter(Boolean).map(String)));
  for (const id of uniq) {
    try {
      const r: any = await db.execute(sql`SELECT first_name, last_name, email FROM users WHERE id = ${id} LIMIT 1`);
      const u = (r.rows || r)[0];
      if (u) map[id] = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || id;
    } catch { /* noop */ }
  }
  return map;
}

export interface AuditActor { id?: string | null; name?: string | null; }

/**
 * Compara `before` (registro atual) com `changes` (payload enviado) e grava uma linha por
 * campo que realmente mudou. Nunca lança (loga e segue) para não quebrar o salvamento.
 */
export async function logCustomerChanges(params: {
  customerId: string;
  before: any;
  changes: any;
  actor?: AuditActor;
  source?: string;
}): Promise<void> {
  const { customerId, before, changes, actor, source } = params;
  if (!customerId || !before || !changes || typeof changes !== 'object') return;
  try {
    await ensureCustomerAuditTable();
    const changed: Array<{ field: string; oldRaw: any; newRaw: any }> = [];
    for (const key of Object.keys(changes)) {
      if (!(key in LABELS)) continue; // apenas campos de negócio rastreados
      const oldRaw = (before as any)[key];
      const newRaw = (changes as any)[key];
      if (canon(key, oldRaw) === canon(key, newRaw)) continue;
      changed.push({ field: key, oldRaw, newRaw });
    }
    if (!changed.length) return;

    const sellerIds: string[] = [];
    for (const c of changed) if (c.field === 'sellerId') { if (c.oldRaw) sellerIds.push(String(c.oldRaw)); if (c.newRaw) sellerIds.push(String(c.newRaw)); }
    const nameMap = sellerIds.length ? await resolveUserNames(sellerIds) : {};

    const actorName = (actor?.name && String(actor.name).trim()) || 'Sistema';
    const actorId = actor?.id || null;

    for (const c of changed) {
      let oldV: string, newV: string;
      if (c.field === 'sellerId') {
        oldV = c.oldRaw ? (nameMap[String(c.oldRaw)] || String(c.oldRaw)) : '—';
        newV = c.newRaw ? (nameMap[String(c.newRaw)] || String(c.newRaw)) : '—';
      } else {
        oldV = fmt(c.field, c.oldRaw);
        newV = fmt(c.field, c.newRaw);
      }
      await db.execute(sql`
        INSERT INTO customer_change_history
          (customer_id, field, label, old_value, new_value, changed_by_user_id, changed_by_name, source)
        VALUES (${customerId}, ${c.field}, ${LABELS[c.field]}, ${oldV}, ${newV}, ${actorId}, ${actorName}, ${source || 'edit'})`);
    }
  } catch (e: any) {
    console.error('[CUSTOMER-AUDIT] falha ao registrar histórico:', e?.message || e);
  }
}

export async function getCustomerChangeHistory(customerId: string, limit = 30): Promise<any[]> {
  await ensureCustomerAuditTable();
  const lim = Math.max(1, Math.min(Number(limit) || 30, 100));
  const r: any = await db.execute(sql`
    SELECT field, label, old_value, new_value, changed_by_name, source, created_at
    FROM customer_change_history
    WHERE customer_id = ${customerId}
    ORDER BY created_at DESC
    LIMIT ${lim}`);
  return (r.rows || r) as any[];
}
