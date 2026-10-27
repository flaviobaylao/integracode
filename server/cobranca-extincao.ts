// ============================================================================
// EXTINCAO DA COBRANCA NO BANCO QUANDO O TITULO E BAIXADO NO INTEGRA (23/set/2026)
// ----------------------------------------------------------------------------
// Regra do Flavio: a baixa no Integra e a baixa da cobranca no banco sao UM fato
// so. Titulo fechado no Integra (recebido, cancelado, baixa administrativa,
// excluido) nao pode deixar boleto registrado no BB nem PIX ativo — senao o
// titulo continua no DDA do cliente e pode ser pago de novo.
//
// Antes disto, so algumas acoes pontuais mandavam o comando de baixa ao BB
// (regerar cobranca, cancelar cobranca, boleto unificado, link de pagamento). A
// baixa manual, a baixa administrativa, o cancelamento/exclusao do titulo, a
// planilha, a conciliacao, o cancelamento/devolucao de NF-e e o pagamento na
// loja fechavam o titulo e deixavam a cobranca viva no banco.
//
// Como funciona:
//   * `extinguirCobrancasDoTitulo(id, origem)` — unica porta. Olha o titulo e,
//     se ele estiver FECHADO, baixa no BB todo boleto vivo dele e remove no BB
//     todo PIX ativo. Idempotente e sem corrida (uma execucao por titulo).
//   * `storage.updateReceivable` (status -> recebida/cancelada) e
//     `storage.deleteReceivable` disparam a funcao — cobre TODOS os caminhos que
//     fecham titulo pelo storage, inclusive os que ainda vao ser escritos.
//   * A baixa manual e a baixa administrativa AGUARDAM o resultado e devolvem
//     `cobrancaBanco` para a tela avisar se o banco recusou.
//   * Varredura de hora em hora (rede de seguranca) pega o que escapou: titulos
//     fechados DEPOIS do corte (`extincao_cobranca_corte`, gravado no 1o boot),
//     falhas do BB e caminhos que fecham titulo por SQL direto.
//   * O ESTOQUE ANTIGO (titulos fechados antes do corte) so e tratado pelo
//     levantamento manual `POST /api/admin/financial/extincao-cobranca/levantamento`
//     (dryRun por padrao), porque a baixa no BB e IRREVERSIVEL.
//
// Travas:
//   * Titulo 'recebida' com saldo em aberto (amount_paid < amount) NAO tem a
//     cobranca extinta — status inconsistente, o dinheiro pode ainda ser devido.
//   * Pagamento PARCIAL nao baixa o boleto (o titulo segue aberto).
//   * Boleto UNIFICADO so e baixado quando TODOS os titulos dele estao fechados.
//   * Boleto liquidado pelo proprio BB (webhook/consulta/varredura) nao e tocado.
//     Boleto marcado 'liquidado' so no Integra (conciliacao/planilha, pagamento
//     que pode ter vindo por PIX/TED) recebe o comando de baixa: se o BB disser
//     que ja esta liquidado, nada muda; se estava aberto, e baixado agora.
//   * PIX CONCLUIDO no banco nunca e removido; vira ALERTA (possivel pagamento em
//     duplicidade).
// Tudo fica em `cobranca_extincao_log`.
// ============================================================================
import type { Express } from 'express';
import { db } from './db';
import { sql } from 'drizzle-orm';
import { cancelarBoleto } from './bb-boleto-service';
import { removerCobrancaPix } from './bb-pix-service';
import { authenticateUser } from './authMiddleware';

type Acao = {
  tipo: 'boleto' | 'pix';
  chave: string | null;
  chargeId: string;
  acao: 'baixado_no_banco' | 'ja_fora_do_banco' | 'removido_no_banco' | 'pulado' | 'erro' | 'alerta';
  detalhe?: string;
};

export type ResultadoExtincao = {
  receivableId: string;
  origem: string;
  fechado: boolean;
  motivo?: string;
  acoes: Acao[];
  boletosBaixados: number;
  pixRemovidos: number;
  erros: string[];
  alertas: string[];
};

const rowsOf = (r: any): any[] => ((r && (r.rows || r)) || []) as any[];
const digits = (s: any) => String(s ?? '').replace(/\D/g, '');

// Status do boleto que ja estao encerrados no nosso lado (nao ha o que baixar).
const BOLETO_ENCERRADO = ['cancelado', 'cancelada', 'baixado'];
const BOLETO_LIQUIDADO = ['liquidado', 'pago', 'recebido'];

let tabelaOk: Promise<void> | null = null;
export function garantirTabelaExtincao(): Promise<void> {
  if (!tabelaOk) {
    tabelaOk = (async () => {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS cobranca_extincao_log (
        id serial PRIMARY KEY,
        receivable_id text,
        tipo text,
        charge_id text,
        chave text,
        acao text,
        detalhe text,
        origem text,
        created_at timestamp DEFAULT now()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS ix_cobranca_extincao_log_rec ON cobranca_extincao_log (receivable_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS ix_cobranca_extincao_log_charge ON cobranca_extincao_log (charge_id)`);
      await db.execute(sql`ALTER TABLE pix_charges ADD COLUMN IF NOT EXISTS bank_removed_at timestamp`);
      // Marca o boleto 'liquidado' cujo estado real ja foi conferido no BB (o banco
      // recusou a baixa por ja estar liquidado). Evita reconsultar toda hora.
      await db.execute(sql`ALTER TABLE boleto_charges ADD COLUMN IF NOT EXISTS bb_conferido_at timestamp`);
      // Indices (27/out/2026): sem eles o levantamento do passado estourava o statement_timeout.
      for (const ddl of [
        sql`CREATE INDEX IF NOT EXISTS ix_boleto_charges_receivable ON boleto_charges (receivable_id)`,
        sql`CREATE INDEX IF NOT EXISTS ix_boleto_charges_nosso_numero ON boleto_charges (nosso_numero)`,
        sql`CREATE INDEX IF NOT EXISTS ix_pix_charges_receivable ON pix_charges (receivable_id)`,
        sql`CREATE INDEX IF NOT EXISTS ix_receivable_payments_receivable ON receivable_payments (receivable_id)`,
        sql`CREATE INDEX IF NOT EXISTS ix_receivable_payments_reference ON receivable_payments (reference)`,
        sql`CREATE INDEX IF NOT EXISTS ix_bcr_receivable ON boleto_charge_receivables (receivable_id)`,
      ]) { try { await db.execute(ddl); } catch (e: any) { console.warn('[EXTINCAO] indice:', e?.message || e); } }
      // Corte: a varredura automatica so trata titulos fechados a partir daqui.
      await db.execute(sql`INSERT INTO system_settings (key, value, updated_by)
        VALUES ('extincao_cobranca_corte', ${new Date().toISOString()}, 'sistema')
        ON CONFLICT (key) DO NOTHING`);
    })().catch((e) => { tabelaOk = null; throw e; });
  }
  return tabelaOk;
}

async function logar(receivableId: string, a: Acao, origem: string) {
  try {
    await db.execute(sql`INSERT INTO cobranca_extincao_log (receivable_id, tipo, charge_id, chave, acao, detalhe, origem)
      VALUES (${receivableId}, ${a.tipo}, ${a.chargeId}, ${a.chave}, ${a.acao}, ${(a.detalhe || '').slice(0, 500)}, ${origem.slice(0, 80)})`);
  } catch (e: any) { console.warn('[EXTINCAO] log falhou:', e?.message || e); }
}

async function contaDoConvenio(numeroConvenio: any): Promise<string | null> {
  const conv = digits(numeroConvenio);
  const q = rowsOf(await db.execute(sql`
    SELECT id FROM financial_accounts
    WHERE bb_boleto_enabled = true AND bb_convenio IS NOT NULL
    ORDER BY (regexp_replace(bb_convenio, '[^0-9]', '', 'g') = ${conv}) DESC, created_at ASC NULLS LAST
    LIMIT 1`));
  return q[0]?.id ? String(q[0].id) : null;
}

// Um titulo esta FECHADO quando foi excluido, cancelado ou recebido por inteiro.
function avaliarTitulo(r: any): { fechado: boolean; motivo?: string } {
  if (!r) return { fechado: true, motivo: 'titulo inexistente' };
  if (r.deleted_at) return { fechado: true, motivo: 'excluido' };
  const st = String(r.status || '');
  if (st === 'cancelada') return { fechado: true, motivo: 'cancelado' };
  if (st === 'recebida') {
    const amt = Number(r.amount || 0), pago = Number(r.amount_paid || 0);
    if (amt > 0 && pago < amt - 0.005) return { fechado: false, motivo: `recebida com saldo em aberto (R$ ${(amt - pago).toFixed(2)}) - status inconsistente, cobranca mantida` };
    return { fechado: true, motivo: 'recebido' };
  }
  return { fechado: false, motivo: 'titulo em aberto' };
}

const emAndamento = new Map<string, Promise<ResultadoExtincao>>();

// No maximo 3 titulos falando com o BB ao mesmo tempo: uma conciliacao em lote que
// fecha 100 titulos nao pode disparar 100 chamadas simultaneas na API do banco.
const MAX_SIMULTANEOS = 3;
let ativos = 0;
const fila: Array<() => void> = [];
async function comVaga<T>(fn: () => Promise<T>): Promise<T> {
  if (ativos >= MAX_SIMULTANEOS) await new Promise<void>((ok) => fila.push(ok));
  ativos++;
  try { return await fn(); }
  finally { ativos--; const prox = fila.shift(); if (prox) prox(); }
}

/** Unica porta: extingue no banco as cobrancas de um titulo FECHADO. */
export function extinguirCobrancasDoTitulo(receivableId: string, origem: string): Promise<ResultadoExtincao> {
  const id = String(receivableId || '');
  const ja = emAndamento.get(id);
  if (ja) return ja;
  const p = comVaga(() => executar(id, origem)).finally(() => emAndamento.delete(id));
  emAndamento.set(id, p);
  return p;
}

/** Dispara sem aguardar (usado pelo storage). Nunca lanca. */
// Espera alguns segundos: quem fecha o titulo pelo storage costuma gravar o
// pagamento e o status da propria cobranca logo DEPOIS do update (webhook do boleto
// e do PIX). Sem a folga, a extincao veria o boleto/PIX que acabou de pagar o titulo
// como "vivo" e acusaria falsa duplicidade.
const FOLGA_MS = 5000;
export function dispararExtincao(receivableId: string, origem: string): void {
  if (!receivableId) return;
  setTimeout(() => disparar(receivableId, origem), FOLGA_MS);
}
function disparar(receivableId: string, origem: string): void {
  extinguirCobrancasDoTitulo(receivableId, origem)
    .then((r) => {
      if (r.boletosBaixados || r.pixRemovidos || r.erros.length || r.alertas.length) {
        console.log(`[EXTINCAO] titulo ${receivableId} (${origem}): boletos baixados=${r.boletosBaixados} pix removidos=${r.pixRemovidos} erros=${r.erros.length} alertas=${r.alertas.length}`);
      }
    })
    .catch((e) => console.error('[EXTINCAO] falhou', receivableId, e?.message || e));
}

async function executar(receivableId: string, origem: string): Promise<ResultadoExtincao> {
  await garantirTabelaExtincao();
  const out: ResultadoExtincao = { receivableId, origem, fechado: false, acoes: [], boletosBaixados: 0, pixRemovidos: 0, erros: [], alertas: [] };
  const rec = rowsOf(await db.execute(sql`SELECT id, status::text AS status, amount, amount_paid, deleted_at FROM receivables WHERE id = ${receivableId} LIMIT 1`))[0];
  const av = avaliarTitulo(rec);
  out.fechado = av.fechado;
  out.motivo = av.motivo;
  if (!av.fechado) return out;

  const registrar = async (a: Acao) => {
    out.acoes.push(a);
    if (a.acao === 'erro') out.erros.push(`${a.tipo} ${a.chave || a.chargeId}: ${a.detalhe || 'falha'}`);
    if (a.acao === 'alerta') out.alertas.push(`${a.tipo} ${a.chave || a.chargeId}: ${a.detalhe || ''}`);
    if (a.acao !== 'pulado') await logar(receivableId, a, origem);
  };

  // ---------------------------------------------------------------- BOLETOS
  const boletos = rowsOf(await db.execute(sql`
    SELECT bc.* FROM boleto_charges bc
    WHERE bc.deleted_at IS NULL
      AND lower(COALESCE(bc.status, '')) NOT IN ('cancelado', 'cancelada', 'baixado')
      AND (bc.receivable_id = ${receivableId}
           OR bc.id IN (SELECT boleto_charge_id FROM boleto_charge_receivables WHERE receivable_id = ${receivableId}))
    ORDER BY bc.created_at DESC`));

  for (const b of boletos) {
    const chave = b.nosso_numero ? String(b.nosso_numero) : null;
    const st = String(b.status || '').toLowerCase();
    if (BOLETO_ENCERRADO.includes(st)) continue;

    // Boleto unificado: so baixa quando TODOS os titulos ligados estao fechados.
    const ligados = rowsOf(await db.execute(sql`
      SELECT r.id, r.status::text AS status, r.amount, r.amount_paid, r.deleted_at
      FROM receivables r
      WHERE r.id IN (SELECT receivable_id FROM boleto_charge_receivables WHERE boleto_charge_id = ${b.id})
         OR r.id = ${b.receivable_id || ''}`));
    const abertos = ligados.filter((x) => x.id !== receivableId && !avaliarTitulo(x).fechado);
    if (abertos.length) {
      await registrar({ tipo: 'boleto', chave, chargeId: String(b.id), acao: 'pulado',
        detalhe: `boleto unificado com ${abertos.length} outro(s) titulo(s) em aberto - mantido` });
      continue;
    }

    const liquidadoLocal = BOLETO_LIQUIDADO.includes(st);
    if (liquidadoLocal) {
      if (b.bb_conferido_at) continue; // ja conferido no BB: liquidado de verdade
      // Liquidacao informada PELO BB (webhook/consulta/varredura/reparo) = pago pelo
      // proprio boleto, o banco ja encerrou. Nao precisa de comando.
      const doBanco = rowsOf(await db.execute(sql`
        SELECT 1 FROM receivable_payments
        WHERE deleted_at IS NULL
          AND (reference = ${chave || '-'} OR notes LIKE ${'%nosso ' + (chave || '-') + '%'})
          AND notes LIKE 'Baixa automatica boleto BB (%'
          AND notes NOT LIKE 'Baixa automatica boleto BB (conciliacao%'
          AND notes NOT LIKE 'Baixa automatica boleto BB (planilha%'
        LIMIT 1`));
      if (doBanco.length) continue;
    }

    const accId = await contaDoConvenio(b.numero_convenio);
    if (!accId) {
      await registrar({ tipo: 'boleto', chave, chargeId: String(b.id), acao: 'erro', detalhe: 'nenhuma conta com boleto BB habilitado para o convenio' });
      continue;
    }
    let r: any;
    try { r = await cancelarBoleto(accId, b); }
    catch (e: any) { r = { ok: false, error: String(e?.message || e) }; }

    if (!r.ok) {
      await registrar({ tipo: 'boleto', chave, chargeId: String(b.id), acao: 'erro', detalhe: String(r.error || 'BB recusou a baixa').slice(0, 300) });
      continue;
    }
    if (r.alreadyBaixado) {
      if (liquidadoLocal) {
        // O BB diz que ja esta liquidado/baixado: o 'liquidado' local e verdadeiro.
        await db.execute(sql`UPDATE boleto_charges SET bb_conferido_at = now() WHERE id = ${b.id}`);
        await registrar({ tipo: 'boleto', chave, chargeId: String(b.id), acao: 'ja_fora_do_banco', detalhe: 'BB confirma liquidado/baixado' });
      } else {
        // Estava vivo no Integra mas o BB diz que ja nao esta aberto. Se foi PAGO pelo
        // boleto e a baixa do Integra veio por outro meio, e pagamento em duplicidade.
        // Se ja existe baixa DESTE boleto no titulo, foi ele que pagou (webhook ainda
        // nao tinha marcado o status) — nada errado, so encerra no nosso lado.
        const foiEste = rowsOf(await db.execute(sql`SELECT 1 FROM receivable_payments
          WHERE receivable_id = ${receivableId} AND deleted_at IS NULL
            AND (reference = ${chave || '-'} OR notes LIKE ${'%nosso ' + (chave || '-') + '%'}) LIMIT 1`)).length > 0;
        if (foiEste) {
          await db.execute(sql`UPDATE boleto_charges SET bb_conferido_at = now() WHERE id = ${b.id}`);
          await registrar({ tipo: 'boleto', chave, chargeId: String(b.id), acao: 'ja_fora_do_banco', detalhe: 'boleto pago - foi ele que quitou o titulo' });
          continue;
        }
        await db.execute(sql`UPDATE boleto_charges SET status = 'cancelado', bb_conferido_at = now() WHERE id = ${b.id}`);
        await registrar({ tipo: 'boleto', chave, chargeId: String(b.id), acao: 'alerta',
          detalhe: 'BB informou que o boleto ja estava baixado/liquidado - conferir se o cliente pagou o boleto E pagou por outro meio (duplicidade)' });
      }
      continue;
    }
    await db.execute(sql`UPDATE boleto_charges SET status = 'cancelado', bb_conferido_at = now() WHERE id = ${b.id}`);
    out.boletosBaixados++;
    await registrar({ tipo: 'boleto', chave, chargeId: String(b.id), acao: 'baixado_no_banco',
      detalhe: (r.sandbox ? '[SANDBOX] ' : '') + (liquidadoLocal ? 'estava liquidado so no Integra - aberto no BB' : 'comando de baixa aceito pelo BB') });
  }

  // ---------------------------------------------------------------- PIX
  const pixs = rowsOf(await db.execute(sql`
    SELECT id, txid, charge_type, financial_account_id, status::text AS status
    FROM pix_charges
    WHERE receivable_id = ${receivableId} AND deleted_at IS NULL AND bank_removed_at IS NULL
      AND status::text IN ('ATIVA', 'REMOVIDA_PELO_USUARIO_RECEBEDOR')`));
  for (const p of pixs) {
    const chave = p.txid ? String(p.txid) : null;
    let r: any;
    try { r = await removerCobrancaPix({ txid: p.txid, chargeType: p.charge_type, financialAccountId: p.financial_account_id }); }
    catch (e: any) { r = { ok: false, erro: String(e?.message || e) }; }
    if (r.paga) {
      // Se foi ESTE PIX que quitou o titulo, nao ha nada de errado.
      const foiEste = rowsOf(await db.execute(sql`SELECT 1 FROM receivable_payments
        WHERE receivable_id = ${receivableId} AND deleted_at IS NULL AND notes LIKE ${'%' + (chave || '-') + '%'} LIMIT 1`)).length > 0;
      // O banco e a verdade: a cob esta CONCLUIDA. Grava isso para nao voltar a ser
      // tratada como viva (e nao repetir o alerta a cada varredura).
      await db.execute(sql`UPDATE pix_charges SET status = 'CONCLUIDA', updated_at = now() WHERE id = ${p.id}`);
      await registrar({ tipo: 'pix', chave, chargeId: String(p.id), acao: foiEste ? 'ja_fora_do_banco' : 'alerta',
        detalhe: foiEste ? 'PIX pago - foi ele que quitou o titulo'
          : 'PIX CONCLUIDO no banco (cliente pagou) e o titulo foi baixado por outro meio - conferir duplicidade' });
      continue;
    }
    if (!r.ok) {
      await registrar({ tipo: 'pix', chave, chargeId: String(p.id), acao: 'erro', detalhe: String(r.erro || 'falha').slice(0, 300) });
      continue;
    }
    await db.execute(sql`UPDATE pix_charges SET status = 'REMOVIDA_PELO_USUARIO_RECEBEDOR', bank_removed_at = now(), updated_at = now()
      WHERE id = ${p.id} AND status::text <> 'CONCLUIDA'`);
    if (r.jaRemovida) {
      await registrar({ tipo: 'pix', chave, chargeId: String(p.id), acao: 'ja_fora_do_banco', detalhe: 'BB: ' + (r.statusBanco || 'ja removida') });
    } else {
      out.pixRemovidos++;
      await registrar({ tipo: 'pix', chave, chargeId: String(p.id), acao: 'removido_no_banco', detalhe: 'cobranca PIX removida no BB' });
    }
  }
  return out;
}

// ============================================================================
// CANDIDATOS: titulos fechados com cobranca possivelmente viva no banco.
// ============================================================================
async function candidatos(opts: { desde?: string | null; limit: number }) {
  const desde = opts.desde || null;
  // 27/out/2026 — a versao anterior estourava o statement_timeout (120 s) em producao
  // quando rodava sem `desde` (levantamento do passado): JOIN com OR entre
  // boleto_charges.receivable_id e boleto_charge_receivables impedia indice, e o
  // teste "liquidado pelo proprio BB" fazia um LIKE em receivable_payments por boleto.
  // Agora: (1) o conjunto de nosso-numeros pagos pelo BB e materializado UMA vez,
  // (2) os dois vinculos boleto<->titulo sao um UNION, (3) indices criados no boot.
  return rowsOf(await db.execute(sql`
    WITH fechados AS (
      SELECT r.id, r.title_number, r.customer_name, r.status::text AS status, r.amount, r.amount_paid,
             r.deleted_at, GREATEST(r.updated_at, r.deleted_at) AS fechado_em
      FROM receivables r
      WHERE (r.deleted_at IS NOT NULL OR r.status::text IN ('recebida', 'cancelada'))
        AND (${desde}::timestamp IS NULL OR GREATEST(r.updated_at, r.deleted_at) >= ${desde}::timestamp)
    ),
    pagos_bb AS (
      SELECT DISTINCT COALESCE(NULLIF(rp.reference, ''), substring(rp.notes from 'nosso ([0-9A-Za-z]+)')) AS nn
      FROM receivable_payments rp
      WHERE rp.deleted_at IS NULL
        AND rp.notes LIKE 'Baixa automatica boleto BB (%'
        AND rp.notes NOT LIKE 'Baixa automatica boleto BB (conciliacao%'
        AND rp.notes NOT LIKE 'Baixa automatica boleto BB (planilha%'
    ),
    vinculo AS (
      SELECT bc.receivable_id AS rid, bc.id AS charge_id FROM boleto_charges bc
       JOIN fechados f ON f.id = bc.receivable_id
      UNION
      SELECT bcr.receivable_id, bcr.boleto_charge_id FROM boleto_charge_receivables bcr
       JOIN fechados f ON f.id = bcr.receivable_id
    ),
    bol AS (
      SELECT DISTINCT ON (bc.id) v.rid, bc.id AS charge_id, bc.nosso_numero AS chave,
             lower(COALESCE(bc.status, '')) AS st, bc.valor_original::numeric AS valor, bc.bb_conferido_at
      FROM vinculo v JOIN boleto_charges bc ON bc.id = v.charge_id
      WHERE bc.deleted_at IS NULL AND lower(COALESCE(bc.status, '')) NOT IN ('cancelado', 'cancelada', 'baixado')
        AND NOT (lower(COALESCE(bc.status, '')) IN ('liquidado', 'pago', 'recebido') AND (
              bc.bb_conferido_at IS NOT NULL OR EXISTS (SELECT 1 FROM pagos_bb pb WHERE pb.nn = bc.nosso_numero)))
    ),
    px AS (
      SELECT f.id AS rid, p.id AS charge_id, p.txid AS chave, p.status::text AS st, p.amount::numeric AS valor
      FROM fechados f JOIN pix_charges p ON p.receivable_id = f.id
      WHERE p.deleted_at IS NULL AND p.bank_removed_at IS NULL
        AND p.status::text IN ('ATIVA', 'REMOVIDA_PELO_USUARIO_RECEBEDOR')
    ),
    alvo AS (
      SELECT f.* FROM fechados f
      WHERE EXISTS (SELECT 1 FROM bol b WHERE b.rid = f.id) OR EXISTS (SELECT 1 FROM px x WHERE x.rid = f.id)
      ORDER BY f.fechado_em DESC NULLS LAST
      LIMIT ${opts.limit}
    )
    SELECT f.*,
      (SELECT COALESCE(json_agg(json_build_object('id', b.charge_id, 'chave', b.chave, 'st', b.st, 'valor', b.valor)), '[]'::json) FROM bol b WHERE b.rid = f.id) AS boletos,
      (SELECT COALESCE(json_agg(json_build_object('id', x.charge_id, 'chave', x.chave, 'st', x.st, 'valor', x.valor)), '[]'::json) FROM px x WHERE x.rid = f.id) AS pixs,
      EXISTS (SELECT 1 FROM receivable_payments rp WHERE rp.receivable_id = f.id AND rp.deleted_at IS NULL) AS tem_baixa,
      EXISTS (SELECT 1 FROM receivable_payments rp WHERE rp.receivable_id = f.id AND rp.deleted_at IS NULL AND rp.financial_account_id IS NULL) AS sem_lastro,
      (SELECT COUNT(*) FROM cobranca_extincao_log l WHERE l.receivable_id = f.id AND l.acao = 'erro')::int AS erros_anteriores
    FROM alvo f
    ORDER BY f.fechado_em DESC NULLS LAST`));
}

// Mesma trava da auditoria de cobrancas vivas: titulo com estado incoerente vai para
// revisao manual em vez de ter a cobranca extinta no historico.
function motivoRevisar(c: any): string | null {
  const amt = Number(c.amount || 0), pago = Number(c.amount_paid || 0);
  if (c.deleted_at) return null;
  if (c.status === 'recebida') {
    if (amt > 0 && pago < amt - 0.005) return 'recebida com saldo em aberto (R$ ' + (amt - pago).toFixed(2) + ')';
    if (!c.tem_baixa) return 'recebida SEM nenhuma baixa registrada';
    if (c.sem_lastro) return 'recebida por baixa SEM conta financeira (sem lastro bancario)';
  }
  if (c.status === 'cancelada' && pago > 0.005) return 'cancelada mas com pagamento registrado (R$ ' + pago.toFixed(2) + ')';
  return null;
}

/** Varredura automatica (cron): so titulos fechados depois do corte. */
export async function varreduraExtincaoCobrancas(limit = 200): Promise<{ candidatos: number; processados: number; boletosBaixados: number; pixRemovidos: number; erros: number; alertas: number; pulados: number }> {
  await garantirTabelaExtincao();
  const corte = rowsOf(await db.execute(sql`SELECT value FROM system_settings WHERE key = 'extincao_cobranca_corte' LIMIT 1`))[0]?.value || new Date().toISOString();
  const lista = await candidatos({ desde: corte, limit });
  const res = { candidatos: lista.length, processados: 0, boletosBaixados: 0, pixRemovidos: 0, erros: 0, alertas: 0, pulados: 0 };
  for (const c of lista) {
    // Titulo que ja falhou 5 vezes para de ser tentado automaticamente (fica no painel).
    if (Number(c.erros_anteriores || 0) >= 5) { res.pulados++; continue; }
    const r = await extinguirCobrancasDoTitulo(String(c.id), 'varredura');
    res.processados++;
    res.boletosBaixados += r.boletosBaixados; res.pixRemovidos += r.pixRemovidos;
    res.erros += r.erros.length; res.alertas += r.alertas.length;
  }
  try {
    await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('extincao_cobranca_ultima', ${JSON.stringify({ at: new Date().toISOString(), ...res })}, 'cron-extincao')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
  } catch {}
  if (res.candidatos) console.log(`[EXTINCAO] varredura: ${JSON.stringify(res)}`);
  return res;
}

// ============================================================================
// ROTAS
// ============================================================================
export function registerCobrancaExtincao(app: Express) {
  garantirTabelaExtincao().catch((e) => console.error('[EXTINCAO] init falhou:', e?.message || e));

  const soFinanceiro = (req: any, res: any, next: any) => {
    const u = req.currentUser || req.user;
    if (!u) return res.status(401).json({ message: 'Não autenticado' });
    if (!['admin', 'coordinator', 'administrative'].includes(u.role)) return res.status(403).json({ message: 'Acesso restrito ao módulo financeiro' });
    next();
  };
  const soAdmin = (req: any, res: any, next: any) => {
    const u = req.currentUser || req.user;
    if (!u || u.role !== 'admin') return res.status(403).json({ message: 'Somente administrador' });
    next();
  };

  // Extingue na hora as cobrancas de UM titulo fechado (botao / reprocessar erro).
  app.post('/api/financial/receivables/:id/extinguir-cobranca', authenticateUser, soFinanceiro, async (req: any, res) => {
    try {
      const u = req.currentUser || req.user;
      const r = await extinguirCobrancasDoTitulo(req.params.id, 'manual:' + (u?.email || '?'));
      res.json({ ok: r.erros.length === 0, ...r });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e).slice(0, 300) }); }
  });

  // LEVANTAMENTO do estoque (inclui o que fechou ANTES do corte).
  // body: { dryRun=true, limit=300, desde?: 'YYYY-MM-DD', incluirRevisar=false }
  // Aplicar e so para admin e a baixa no BB e IRREVERSIVEL.
  app.post('/api/admin/financial/extincao-cobranca/levantamento', authenticateUser, soFinanceiro, async (req: any, res) => {
    try {
      await garantirTabelaExtincao();
      const dryRun = req.body?.dryRun !== false;
      const limit = Math.min(Math.max(Number(req.body?.limit) || 300, 1), 5000);
      const desde = req.body?.desde ? String(req.body.desde).slice(0, 25) : null;
      const incluirRevisar = req.body?.incluirRevisar === true;
      const u = req.currentUser || req.user;
      if (!dryRun && u?.role !== 'admin') return res.status(403).json({ message: 'Aplicar a baixa no banco e somente para administrador' });

      const lista = await candidatos({ desde, limit: dryRun ? 5000 : limit * 3 });
      const n2 = (v: any) => Number(Number(v || 0).toFixed(2));
      const aptos: any[] = [], revisar: any[] = [], desistidos: any[] = [];
      for (const c of lista) {
        // 27/out/2026: mesmo teto do cron — titulo que ja falhou 5x no banco (ex.: PIX
        // com vencimento sem escopo /cobv na aplicacao) sai do lote em vez de ocupar
        // vaga em toda chamada. Volta se a causa for corrigida (basta zerar o log de erro).
        if (Number(c.erros_anteriores || 0) >= 5) { desistidos.push(c); continue; }
        const mot = motivoRevisar(c);
        (mot && !incluirRevisar ? revisar : aptos).push({ ...c, motivoRevisar: mot });
      }
      const resumir = (arr: any[]) => {
        let bv = 0, bl = 0, px = 0, valor = 0;
        for (const c of arr) {
          for (const b of (c.boletos || [])) { if (['liquidado', 'pago', 'recebido'].includes(b.st)) bl++; else bv++; valor += Number(b.valor || 0); }
          for (const p of (c.pixs || [])) { px++; valor += Number(p.valor || 0); }
        }
        return { titulos: arr.length, boletosVivos: bv, boletosLiquidadosSoNoIntegra: bl, pixVivos: px, valor: n2(valor) };
      };
      const amostra = (arr: any[], n = 60) => arr.slice(0, n).map((c) => ({
        id: c.id, titulo: c.title_number, cliente: c.customer_name, status: c.deleted_at ? 'excluido' : c.status,
        valorTitulo: n2(c.amount), pago: n2(c.amount_paid), fechadoEm: c.fechado_em,
        boletos: (c.boletos || []).map((b: any) => `${b.chave || b.id} (${b.st || '?'}) R$ ${n2(b.valor)}`),
        pixs: (c.pixs || []).map((p: any) => `${p.chave || p.id} (${p.st}) R$ ${n2(p.valor)}`),
        ...(c.motivoRevisar ? { motivo: c.motivoRevisar } : {}),
      }));

      if (dryRun) {
        return res.json({
          dryRun: true, desde, aExtinguir: resumir(aptos), revisarManual: resumir(revisar), desistidos5Erros: resumir(desistidos),
          amostra: amostra(aptos), amostraRevisar: amostra(revisar, 40),
          observacao: 'boletosVivos = registrados/vencidos no Integra; boletosLiquidadosSoNoIntegra = marcados liquidados pela conciliacao/planilha (o BB decide: se ja liquidado, nada muda; se aberto, e baixado). Cada cobranca = 1 chamada ao BB.',
          irreversivel: 'Boleto baixado no BB nao volta - so reemitindo. Aplicar: {dryRun:false, limit:N} (admin).',
        });
      }
      const lote = aptos.slice(0, limit);
      const tot = { processados: 0, boletosBaixados: 0, pixRemovidos: 0, erros: [] as string[], alertas: [] as string[] };
      for (const c of lote) {
        const r = await extinguirCobrancasDoTitulo(String(c.id), 'levantamento:' + (u?.email || '?'));
        tot.processados++; tot.boletosBaixados += r.boletosBaixados; tot.pixRemovidos += r.pixRemovidos;
        for (const e of r.erros) if (tot.erros.length < 50) tot.erros.push(`${c.title_number || c.id}: ${e}`);
        for (const a of r.alertas) if (tot.alertas.length < 50) tot.alertas.push(`${c.title_number || c.id}: ${a}`);
      }
      try {
        const { logFinancialAudit } = await import('./financial-audit');
        await logFinancialAudit({ req, action: 'reverse', entity: 'cobrancas', entityId: null, amount: null as any,
          note: `Extincao de cobrancas de titulos fechados: ${tot.boletosBaixados} boleto(s) baixado(s) no BB, ${tot.pixRemovidos} PIX removido(s), ${tot.erros.length} erro(s), ${tot.alertas.length} alerta(s).` } as any);
      } catch {}
      res.json({ dryRun: false, restantes: Math.max(0, aptos.length - lote.length), revisarManual: revisar.length, desistidos5Erros: desistidos.length, ...tot });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e).slice(0, 400) }); }
  });

  // Painel: ultimas acoes, erros e alertas + ultima varredura.
  app.get('/api/admin/financial/extincao-cobranca/log', authenticateUser, soFinanceiro, async (req: any, res) => {
    try {
      await garantirTabelaExtincao();
      const lim = Math.min(Math.max(Number(req.query?.limit) || 100, 1), 1000);
      const acao = req.query?.acao ? String(req.query.acao) : null;
      const itens = rowsOf(await db.execute(sql`
        SELECT l.*, r.title_number AS titulo, r.customer_name AS cliente
        FROM cobranca_extincao_log l LEFT JOIN receivables r ON r.id = l.receivable_id
        WHERE (${acao}::text IS NULL OR l.acao = ${acao})
        ORDER BY l.created_at DESC LIMIT ${lim}`));
      const resumo = rowsOf(await db.execute(sql`SELECT acao, COUNT(*)::int AS n FROM cobranca_extincao_log GROUP BY acao`));
      const cfg = rowsOf(await db.execute(sql`SELECT key, value FROM system_settings WHERE key IN ('extincao_cobranca_corte', 'extincao_cobranca_ultima')`));
      const get = (k: string) => cfg.find((x) => x.key === k)?.value || null;
      let ultima: any = get('extincao_cobranca_ultima'); try { ultima = ultima ? JSON.parse(ultima) : null; } catch {}
      res.json({ corte: get('extincao_cobranca_corte'), ultimaVarredura: ultima, resumo, itens });
    } catch (e: any) { res.status(500).json({ error: String(e?.message || e).slice(0, 300) }); }
  });

  // Dispara a varredura na hora (a mesma do cron).
  app.post('/api/admin/financial/extincao-cobranca/varredura', authenticateUser, soAdmin, async (_req: any, res) => {
    try { res.json(await varreduraExtincaoCobrancas(Number(_req.body?.limit) || 200)); }
    catch (e: any) { res.status(500).json({ error: String(e?.message || e).slice(0, 300) }); }
  });
}
