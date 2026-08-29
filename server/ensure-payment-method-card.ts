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
let _doneRouteMode = false;
let _doneLeadCols = false;

// ============================================================================
// TRAVA DA ROTA DO DIA (19/ago/2026) — o schema Drizzle de daily_routes passou a
// declarar a coluna route_mode (feature "Rota de Prospecção"), mas a coluna nunca
// foi criada no banco de producao (migracao nao aplicada). Como o Drizzle faz
// SELECT/INSERT com TODAS as colunas do schema, qualquer operacao em daily_routes
// (inclusive gerar/regenerar rota) morria com:
//   column "route_mode" does not exist
// derrubando o botao "Gerar Rota" com o toast generico "Erro ao gerar rota".
// (A tela de listagem seguia funcionando porque le via SQL cru.)
//
// Este ensure acrescenta a coluna de forma idempotente (ADD COLUMN IF NOT EXISTS),
// com DEFAULT 'dia' NOT NULL — o Postgres preenche as linhas existentes com 'dia'.
// Roda no start (chamado a partir de ensurePaymentMethodCard, ja fiado no bootstrap),
// nao depende de drizzle-kit push e nunca derruba a subida.
// ============================================================================
export async function ensureDailyRouteMode(): Promise<void> {
  if (_doneRouteMode) return;
  try {
    await db.execute(sql.raw(`ALTER TABLE daily_routes ADD COLUMN IF NOT EXISTS route_mode varchar NOT NULL DEFAULT 'dia'`));
    _doneRouteMode = true;
    console.log("✅ [SCHEMA] daily_routes.route_mode garantido (geracao de rota volta a funcionar).");
  } catch (e: any) {
    console.warn("⚠️ [SCHEMA] nao foi possivel garantir daily_routes.route_mode:", e?.message || e);
  }
}

// ============================================================================
// TRAVA DOS LEADS (19/ago/2026) — o schema Drizzle de leads passou a declarar as
// colunas route_type (alocacao Rota do Dia/Prospeccao) e city (Municipio), mas as
// colunas nunca foram criadas no banco. Como o Drizzle faz UPDATE ... RETURNING com
// TODAS as colunas do schema, QUALQUER atualizacao de lead (alteracao em massa,
// "Enviar para Rota", editar Proximo Contato) morria com:
//   column "route_type" does not exist
// Este ensure acrescenta as colunas de forma idempotente (ADD COLUMN IF NOT EXISTS).
// ============================================================================
export async function ensureLeadColumns(): Promise<void> {
  if (_doneLeadCols) return;
  try {
    await db.execute(sql.raw(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS route_type varchar NOT NULL DEFAULT 'dia'`));
    await db.execute(sql.raw(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS city varchar`));
    await db.execute(sql.raw(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS periodicity varchar DEFAULT 'semanal'`));
    _doneLeadCols = true;
    console.log("✅ [SCHEMA] leads.route_type e leads.city garantidos (alteracao em massa e coluna Municipio voltam a funcionar).");
  } catch (e: any) {
    console.warn("⚠️ [SCHEMA] nao foi possivel garantir colunas de leads:", e?.message || e);
  }
}

export async function ensurePaymentMethodCard(): Promise<void> {
  // Colocado aqui porque este bootstrap ja e chamado no start; a funcao tem guarda
  // propria (_doneRouteMode), entao roda no maximo uma vez com sucesso por processo.
  await ensureDailyRouteMode();
  await ensureLeadColumns();
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
