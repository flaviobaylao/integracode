import { db } from './db';
import { sql } from 'drizzle-orm';

// ============================================================================
// LANCAMENTO EM CONTA — ATOMICO (item 6 da auditoria financeira)
//
// O modulo financeiro creditava a conta assim, em todo lugar:
//
//     const cur = parseFloat(account.balance);      // le
//     const nb  = cur + valor;                      // soma em memoria
//     createAccountMovement({ balanceAfter: nb });  // grava o movimento
//     updateFinancialAccount({ balance: nb });      // grava o saldo
//
// Sao quatro passos sem transacao e sem lock. Dois pagamentos que chegam juntos
// leem o MESMO saldo, somam cada um o seu valor e o ultimo a gravar apaga o
// outro: o saldo perde um lancamento e a cadeia de balance_after quebra. Foi
// medido: 344 elos quebrados em 2.429 movimentos da BB - MATRIZ.
//
// Aqui o lancamento vira UMA transacao:
//   1. UPDATE ... SET balance = balance + delta RETURNING balance
//      O proprio UPDATE trava a LINHA da conta ate o commit, entao o segundo
//      pagamento espera e soma sobre o saldo ja atualizado. Nao existe leitura
//      em memoria para ficar velha.
//   2. INSERT do movimento com balance_after = o saldo devolvido pelo UPDATE.
// Se o INSERT falhar, o UPDATE do saldo e desfeito junto (rollback): nunca sobe
// saldo sem rastro, que era o defeito do link de cartao.
//
// IDEMPOTENCIA (opcional): com `idempotente`, o mesmo (sourceType, reference,
// tipo, valor) nao e lancado duas vezes. A checagem roda DEPOIS do UPDATE, ou
// seja, ja com a linha da conta travada — entao dois webhooks simultaneos do
// mesmo pagamento nao passam os dois. Ao detectar repeticao a transacao e
// revertida e o saldo fica intacto. E a mesma familia de defeito do item 2
// (391 cobrancas creditadas mais de uma vez, uma delas 13 vezes).
// ============================================================================

export type LancamentoConta = {
  accountId: string;
  tipo: 'credito' | 'debito';
  valor: number;
  descricao: string;
  sourceType?: string | null;
  sourceId?: string | null;
  reference?: string | null;
  omieInstanceId?: string | null;
  createdBy?: string | null;
  idempotente?: boolean;
};

export type ResultadoLancamento = {
  ok: boolean;
  repetido?: boolean;
  balanceAfter?: number;
  movementId?: string;
  erro?: string;
};

const REPETIDO = '__LANCAMENTO_REPETIDO__';

export async function lancarNaConta(l: LancamentoConta): Promise<ResultadoLancamento> {
  const valor = Number(l.valor || 0);
  if (!l.accountId) return { ok: false, erro: 'accountId obrigatorio' };
  if (!(Math.abs(valor) > 0.004)) return { ok: false, erro: 'valor zerado' };
  const delta = l.tipo === 'debito' ? -Math.abs(valor) : Math.abs(valor);
  const valorTxt = Math.abs(valor).toFixed(2);

  try {
    const saida = await db.transaction(async (tx: any) => {
      // 1) saldo somado no banco, com a linha da conta travada ate o commit
      const upd: any = await tx.execute(sql`
        UPDATE financial_accounts
        SET balance = (COALESCE(balance, 0)::numeric + ${delta.toFixed(2)}::numeric)::numeric(14,2)
        WHERE id = ${l.accountId}
        RETURNING balance`);
      const linhas = (upd.rows || upd) as any[];
      if (!linhas.length) throw new Error('conta financeira nao encontrada');
      const balanceAfter = Number(linhas[0].balance);

      // 2) ja lancado? (a conta ja esta travada, entao a checagem e confiavel)
      if (l.idempotente && l.sourceType && l.reference) {
        const jaTem: any = await tx.execute(sql`
          SELECT id FROM account_movements
          WHERE source_type = ${l.sourceType} AND reference = ${l.reference}
            AND type = ${l.tipo} AND round(amount::numeric, 2) = ${valorTxt}::numeric
            AND reversed_at IS NULL
          LIMIT 1`);
        if (((jaTem.rows || jaTem) as any[]).length) throw new Error(REPETIDO);
      }

      // 3) movimento com o saldo REAL depois do lancamento
      const ins: any = await tx.execute(sql`
        INSERT INTO account_movements
          (id, financial_account_id, type, amount, balance_after, description,
           source_type, source_id, reference, omie_instance_id, created_by, created_at)
        VALUES
          (gen_random_uuid(), ${l.accountId}, ${l.tipo}, ${valorTxt}, ${balanceAfter.toFixed(2)},
           ${String(l.descricao || '').slice(0, 400)}, ${l.sourceType ?? null}, ${l.sourceId ?? null},
           ${l.reference ?? null}, ${l.omieInstanceId ?? null}, ${l.createdBy ?? 'sistema'}, now())
        RETURNING id`);
      const movementId = String(((ins.rows || ins) as any[])[0]?.id || '');
      return { balanceAfter, movementId };
    });
    return { ok: true, balanceAfter: saida.balanceAfter, movementId: saida.movementId };
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (msg.includes(REPETIDO)) {
      // transacao revertida: o saldo NAO foi alterado
      return { ok: true, repetido: true };
    }
    console.warn('[conta] lancamento falhou:', msg.slice(0, 200));
    return { ok: false, erro: msg.slice(0, 200) };
  }
}
