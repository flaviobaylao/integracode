import { db } from './db';
import { sql } from 'drizzle-orm';

// ─────────────────────────────────────────────────────────────────────────────
// Trilha de auditoria financeira (append-only).
// Registra QUEM fez, O QUÊ, QUANDO, em qual entidade, com o antes/depois.
// Nunca é editada nem apagada. Falhas ao logar NÃO bloqueiam a operação de negócio
// (o log é observabilidade; a consistência do dado vem das transações da Fase 2).
// ─────────────────────────────────────────────────────────────────────────────

export type FinAuditAction =
  | 'create' | 'update' | 'delete' | 'restore'
  | 'pay' | 'reverse' | 'status' | 'reconcile' | 'unreconcile' | 'config';

// Cria a tabela e as colunas de atribuição/soft-delete (tudo ADITIVO e idempotente).
// Chamar no bloco de boot do index.ts (junto dos demais ALTER ... IF NOT EXISTS).
export async function ensureFinancialAuditSchema(): Promise<void> {
  const run = (q: string) => db.execute(sql.raw(q)).catch((e: any) =>
    console.error('[fin-audit] schema:', String(e?.message || e).slice(0, 160)));

  await run(`CREATE TABLE IF NOT EXISTS financial_audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    action varchar NOT NULL,
    entity varchar NOT NULL,
    entity_id varchar,
    user_id varchar,
    user_email varchar,
    user_role varchar,
    amount numeric(14,2),
    before_json jsonb,
    after_json jsonb,
    note text,
    ip varchar,
    created_at timestamp DEFAULT now()
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_fin_audit_entity ON financial_audit_log (entity, entity_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_fin_audit_created ON financial_audit_log (created_at DESC)`);

  // Colunas de atribuição de edição e soft-delete — aditivas, nunca destrutivas.
  const tables = [
    'receivables', 'payables', 'receivable_payments', 'payable_payments',
    'pix_charges', 'boleto_charges', 'financial_accounts', 'chart_of_accounts',
  ];
  for (const t of tables) {
    await run(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS updated_by varchar`);
    await run(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS deleted_at timestamp`);
    await run(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS deleted_by varchar`);
  }
}

// Extrai o usuário autenticado do request (corrige o bug req.user → req.currentUser).
export function actorOf(req: any): { id: string | null; email: string | null; role: string | null } {
  const u = req ? (req.currentUser || req.user || null) : null;
  return {
    id: u?.id ?? null,
    email: u?.email ?? (u?.claims?.email ?? null),
    role: u?.role ?? null,
  };
}

// IP de origem, respeitando proxy (Railway).
function ipOf(req: any): string | null {
  if (!req) return null;
  const xf = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket?.remoteAddress || req.ip || null;
}

// Registra um evento de auditoria. Chamar em toda escrita financeira (create/update/
// delete/pay/reverse/status/reconcile/config).
export async function logFinancialAudit(params: {
  req?: any;
  action: FinAuditAction;
  entity: string;
  entityId?: string | null;
  before?: any;
  after?: any;
  amount?: number | null;
  note?: string | null;
}): Promise<void> {
  try {
    const a = actorOf(params.req);
    await db.execute(sql`
      INSERT INTO financial_audit_log
        (action, entity, entity_id, user_id, user_email, user_role, amount, before_json, after_json, note, ip)
      VALUES
        (${params.action}, ${params.entity}, ${params.entityId ?? null},
         ${a.id}, ${a.email}, ${a.role}, ${params.amount ?? null},
         ${params.before ? JSON.stringify(params.before) : null}::jsonb,
         ${params.after ? JSON.stringify(params.after) : null}::jsonb,
         ${params.note ?? null}, ${ipOf(params.req)})
    `);
  } catch (e: any) {
    console.error('[fin-audit] falha ao registrar (não bloqueia a operação):', String(e?.message || e).slice(0, 200));
  }
}
