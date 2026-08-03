// ============================================================================
// TRAVA DO CARTAO (03/ago/2026) — o enum payment_method do Postgres foi criado
// com apenas ('a_vista','boleto','pix'), mas o endpoint publico da loja
// (POST /api/public/orders) aceita paymentMethod 'card' e o fluxo de cartao
// (hotsite-card.ts) SEMPRE envia 'card' depois que a Cielo aprova o pagamento.
// Resultado em producao: o cliente era COBRADO e a criacao do pedido morria com
//   invalid input value for enum payment_method: "card"
// deixando dinheiro capturado e nenhum pedido no sistema.
//
// Este modulo acrescenta o valor 'card' ao enum de forma idempotente, no mesmo
// padrao dos demais bootstraps do projeto (ensureTable / ensureOrderJournal):
// roda no start, nao depende de drizzle-kit push e nunca derruba o servidor.
//
// Observacao sobre Postgres: ALTER TYPE ... ADD VALUE nao pode rodar dentro de
// um bloco de transacao. db.execute roda em autocommit, entao a chamada abaixo e
// segura; ainda assim o try/catch garante que qualquer falha vire apenas um
// aviso no log em vez de impedir a subida da aplicacao.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

let _done = false;

export async function ensurePaymentMethodCard(): Promise<void> {
  if (_done) return;
  try {
    const q: any = await db.execute(sql`
      SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'payment_method' AND e.enumlabel = 'card'
      LIMIT 1`);
    const jaTem = ((q.rows || q || []) as any[]).length > 0;
    if (jaTem) {
      _done = true;
      return;
    }
    await db.execute(sql.raw(`ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'card'`));
    console.log("✅ [SCHEMA] enum payment_method: valor 'card' acrescentado (pedidos de cartao voltam a ser criados).");
    _done = true;
  } catch (e: any) {
    // Nunca derruba a subida: sem isto o cartao continua quebrado, mas o resto do
    // sistema segue funcionando e o aviso fica visivel no log do deploy.
    console.warn("⚠️ [SCHEMA] nao foi possivel acrescentar 'card' ao enum payment_method:", e?.message || e);
  }
}
